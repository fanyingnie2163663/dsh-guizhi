import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { buildPack } from '../lib/packs.js'
import { schemas } from '../lib/schemas.js'
import { ApplyError, apply, preview, rollback } from '../lib/apply.js'
import { buildPackSkill } from '../lib/skillpack.js'

/** 测试用临时数据根（对应 D16 的 $DSH_HOME/guizhi），套件结束后统一删除。 */
const cleanup = []
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
})

/** 一个新的空数据根。 */
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-apply-'))
  cleanup.push(home)
  return home
}

/** 一个通过 schemas.map.validate 的 D7 地图：两阶段，带可选 tools/skills（R-4A）。 */
function makeMap() {
  return {
    scenarios: ['dev'],
    stages: [
      { id: 'understand', title: '理解需求', capabilities: [], tools: ['read'], skills: ['brainstorming'] },
      {
        id: 'deliver',
        title: '交付',
        capabilities: [{ id: 'ship', title: '交付能力', status: 'have', evidence: { source: 'scan' } }],
        tools: ['read', 'edit'],
      },
    ],
  }
}

/** 同一个地图但 understand 阶段多声明一个 write 工具：用来模拟「打包后地图又变了」。 */
function makeMapV2() {
  return {
    ...makeMap(),
    stages: makeMap().stages.map((stage) => (stage.id === 'understand' ? { ...stage, tools: ['read', 'write'] } : stage)),
  }
}

/** 一条 kind=pack 的合法提案：evidence.refs 就是 buildPack 的 stageIds。 */
function packProposal(overrides = {}) {
  return {
    id: 'pack-1',
    kind: 'pack',
    title: '研发助手包',
    effect: '按选中的工作流阶段生成能力包',
    evidence: { source: 'map', refs: ['understand', 'deliver'] },
    ...overrides,
  }
}

/** 一个真实 buildPack 产物：F2 起 apply 只导出 store('packs') 里存储的包。 */
function makePack(map = makeMap(), stageIds = ['understand', 'deliver'], title = '研发助手包') {
  return buildPack({ map, stageIds, title })
}

/** 把 pack 包成 proposals 文档里的 kind=pack 提案（proposal id 必须等于 pack id，apply 按它查存储包）。 */
function packProposalFor(pack, overrides = {}) {
  return {
    id: pack.id,
    kind: 'pack',
    title: pack.title,
    effect: '按选中的工作流阶段生成能力包',
    evidence: { source: 'map', refs: pack.stageIds.slice() },
    ...overrides,
  }
}

/** store('packs') 状态文档（F2）。 */
function packsDoc(...packs) {
  return { packs }
}

/** 一条 kind=install 的合法提案（v1 只应产生 warning，不写 profile）。 */
function installProposal(overrides = {}) {
  return {
    id: 'install-1',
    kind: 'install',
    title: '安装插件 demo-plugin',
    effect: '补齐缺失能力',
    evidence: { source: 'catalog', refs: ['demo-plugin'] },
    ...overrides,
  }
}

/** 一条 kind=skill 的合法提案（v1 同样只产生 warning）。 */
function skillProposal(overrides = {}) {
  return {
    id: 'skill-1',
    kind: 'skill',
    title: '安装技能 demo-skill',
    effect: '补齐缺失技能',
    evidence: { source: 'catalog' },
    ...overrides,
  }
}

/** 与 D7 一致的 proposals 文档。 */
function makeProposals(items) {
  return { items, generatedAt: '2026-11-26T00:00:00.000Z' }
}

/** 用真实文件系统搭一个数据根，并可选写入 map / proposals / packs 状态。 */
async function seed({ map, proposals, packs } = {}) {
  const home = await makeHome()
  const store = createStore({ home })
  if (map !== undefined) await store.write('map', map)
  if (proposals !== undefined) await store.write('proposals', proposals)
  if (packs !== undefined) await store.write('packs', packs)
  return { home, store }
}

/** home 下递归的路径列表（目录也计入），用来断言「没有写盘」。 */
async function tree(dir) {
  return (await readdir(dir, { recursive: true })).sort()
}

/** home 里原子写遗留的 .tmp 文件。 */
async function tempLeftovers(dir) {
  return (await tree(dir)).filter((path) => path.endsWith('.tmp'))
}

/** 文件/目录是否存在。 */
async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * 独立复算 preview.hash：对象键按字典序、数组保持顺序的 canonical JSON。
 * 与实现不共享代码，避免用实现给自己当证据。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    const body = keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',')
    return '{' + body + '}'
  }
  return JSON.stringify(value)
}

/** 从真实文件系统读出 apply 记账条目（F1：{path, existedBefore}）。 */
async function readLedgerEntries(home, snapshotId) {
  const file = join(home, 'snapshots', snapshotId, 'packs-created.json')
  const doc = JSON.parse(await readFile(file, 'utf8'))
  if (Array.isArray(doc.entries)) return doc.entries
  // 兼容旧快照（升级前的 {paths} 台账按「非本次新建」处理，但仍只在 packs 内删除）。
  if (Array.isArray(doc.paths)) return doc.paths.map((path) => ({ path, existedBefore: false }))
  throw new Error('台账形状无法识别：' + JSON.stringify(doc))
}

/** 从真实文件系统读出 apply 记账记录的 pack 路径。 */
async function readLedgerPaths(home, snapshotId) {
  return (await readLedgerEntries(home, snapshotId)).map((entry) => entry.path)
}

/* ------------------------------------------------------------------ preview */

test('preview：默认为全部提案，items 键固定为 id/kind/title/effect，hash 是 canonical JSON 的 sha256', async () => {
  const proposals = makeProposals([packProposal(), installProposal(), skillProposal()])
  const { store } = await seed({ map: makeMap(), proposals })
  const result = await preview({ scan: null, map: makeMap(), proposals, store })
  assert.deepEqual(result.items.map((item) => item.id), ['pack-1', 'install-1', 'skill-1'])
  assert.deepEqual(result.items.map((item) => item.kind), ['pack', 'install', 'skill'])
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item), ['id', 'kind', 'title', 'effect'])
    assert.equal(typeof item.title, 'string')
    assert.equal(typeof item.effect, 'string')
  }
  assert.match(result.hash, /^[0-9a-f]{64}$/)
  assert.equal(result.hash, createHash('sha256').update(canonicalJson(result.items)).digest('hex'))
  // canonical 按字典序排键，与保留插入顺序的 JSON.stringify 不同：证明真的做了规范化
  assert.notEqual(canonicalJson(result.items), JSON.stringify(result.items))
})

test('preview：同输入同输出（重复调用、深拷贝输入的 hash 完全一致）', async () => {
  const { store } = await seed({})
  const one = await preview({ scan: null, map: null, proposals: makeProposals([packProposal(), installProposal()]), store })
  const two = await preview({ scan: null, map: null, proposals: makeProposals([packProposal(), installProposal()]), store })
  assert.deepEqual(one, two)
  assert.equal(one.hash, two.hash)
})

test('preview：给定 ids 时只含选中项且顺序按 ids，未选中的不进 items/hash', async () => {
  const proposals = makeProposals([packProposal(), installProposal(), skillProposal()])
  const { store } = await seed({})
  const all = await preview({ proposals, store })
  const result = await preview({ proposals, store, ids: ['skill-1', 'pack-1'] })
  assert.deepEqual(result.items.map((item) => item.id), ['skill-1', 'pack-1'])
  assert.equal(result.items.length, 2)
  assert.notEqual(result.hash, all.hash)
  assert.equal(result.hash, createHash('sha256').update(canonicalJson(result.items)).digest('hex'))
  const none = await preview({ proposals, store, ids: [] })
  assert.deepEqual(none.items, [])
  assert.equal(none.hash, createHash('sha256').update('[]').digest('hex'))
})

test('preview：未知 id 抛 ApplyError（不静默丢弃），不写盘也不修改输入', async () => {
  const proposals = makeProposals([packProposal(), installProposal()])
  const { home, store } = await seed({ map: makeMap(), proposals })
  const before = await tree(home)
  const inputBefore = JSON.stringify(proposals)
  const error = await preview({ proposals, store, ids: ['pack-1', 'ghost'] }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.match(error.message, /ghost/)
  assert.deepEqual(await tree(home), before)
  assert.equal(JSON.stringify(proposals), inputBefore)
})

test('preview：纯函数，不在数据根里落任何文件', async () => {
  const proposals = makeProposals([packProposal()])
  const { home, store } = await seed({ map: makeMap(), proposals })
  const before = await tree(home)
  await preview({ scan: null, map: makeMap(), proposals, store })
  assert.deepEqual(await tree(home), before)
})

test('preview：proposals 缺失或形状不符时抛 ApplyError（含未知 kind）', async () => {
  const { store } = await seed({})
  const bad = [
    null,
    undefined,
    {},
    { items: 'x', generatedAt: '2026-11-26T00:00:00.000Z' },
    { items: [], generatedAt: 42 },
    { items: [packProposal()] },
    makeProposals([{ ...packProposal(), kind: 'other' }]),
    makeProposals([{ ...packProposal(), evidence: { source: 'map', refs: 'understand' } }]),
  ]
  for (const proposals of bad) {
    await assert.rejects(preview({ proposals, store }), ApplyError, JSON.stringify(proposals))
  }
})

test('preview：ids 非法（非数组/非字符串/空串/重复）抛 ApplyError', async () => {
  const proposals = makeProposals([packProposal(), installProposal()])
  const { store } = await seed({})
  for (const ids of ['pack-1', [42], [''], ['pack-1', 'pack-1'], [null]]) {
    await assert.rejects(preview({ proposals, store, ids }), ApplyError, JSON.stringify(ids))
  }
})

test('preview/apply：提案文档内重复 id → ApplyError（避免 preview 全列 / apply 只取最后一条的漂移）', async () => {
  const duplicated = makeProposals([packProposal(), packProposal({ title: '重复 id 的第二条' })])
  const { home, store } = await seed({ map: makeMap(), proposals: duplicated })
  const previewError = await preview({ proposals: duplicated, store }).then(() => null, (err) => err)
  assert.ok(previewError instanceof ApplyError)
  assert.equal(previewError.code, 'PROPOSALS_INVALID')
  assert.match(previewError.message, /重复/)
  const applyError = await apply({ ids: ['pack-1'], store, home }).then(() => null, (err) => err)
  assert.ok(applyError instanceof ApplyError)
  assert.equal(applyError.code, 'PROPOSALS_INVALID')
  assert.deepEqual(await store.listSnapshots(), [])
})

/* -------------------------------------------------------------------- apply */

test('apply：按提案 id 从 store(packs) 导出已存储的包，install/skill 只进 warnings，快照与记账写出', async () => {
  const storedPack = makePack()
  const proposal = packProposalFor(storedPack)
  const proposals = makeProposals([proposal, installProposal(), skillProposal()])
  const { home, store } = await seed({ map: makeMap(), proposals, packs: packsDoc(storedPack) })
  const before = await tree(home)
  const result = await apply({ ids: ['install-1', proposal.id, 'skill-1'], store, home, now: 1790000000000 })
  assert.deepEqual(result.applied, [proposal.id])
  assert.equal(result.warnings.length, 2)
  assert.ok(result.warnings.every((warning) => warning.includes('v1 暂不安装')), JSON.stringify(result.warnings))
  assert.ok(result.warnings.some((warning) => warning.includes('demo-plugin')))
  assert.ok(result.warnings.some((warning) => warning.includes('demo-skill')))
  assert.match(result.snapshotId, /^[0-9A-Za-z][0-9A-Za-z-]+$/)

  const snapshots = await store.listSnapshots()
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].id, result.snapshotId)
  assert.equal(snapshots[0].tag, 'before-apply')
  const snapshotDir = join(home, 'snapshots', result.snapshotId)
  assert.deepEqual(JSON.parse(await readFile(join(snapshotDir, 'proposals.json'), 'utf8')), proposals)

  const packNames = (await readdir(join(home, 'packs'))).sort()
  assert.equal(packNames.length, 1)
  const packPath = join(home, 'packs', packNames[0])
  const pack = JSON.parse(await readFile(packPath, 'utf8'))
  assert.deepEqual(schemas.pack.validate(pack), { ok: true, errors: [] })
  assert.equal(packPath, join(home, 'packs', pack.id + '.json'))
  assert.equal(pack.title, '研发助手包')
  assert.deepEqual(pack.stageIds, ['understand', 'deliver'])
  assert.deepEqual(pack.tools, ['read', 'edit'])
  assert.deepEqual(pack.skills, ['brainstorming'])
  assert.deepEqual(await readLedgerEntries(home, result.snapshotId), [{ path: packPath, existedBefore: false }])
  assert.deepEqual((await store.read('packs')).value, packsDoc(storedPack), 'apply 不得改写 packs 状态文档')

  // 所有新增文件都在 home 内，只落在 packs/ 与 snapshots/（没有任何 profile 写入）
  const created = (await tree(home)).filter((path) => !before.includes(path))
  assert.ok(created.length > 0)
  assert.ok(created.every((path) => path.startsWith('packs') || path.startsWith('snapshots')), JSON.stringify(created))
  assert.ok(created.every((path) => !path.toLowerCase().includes('profiles')))
  assert.equal(await exists(join(home, 'profiles')), false)
  assert.deepEqual(await tempLeftovers(home), [])
})

test('apply：只选 install/skill 时 applied 为空、记账为空、不生成 pack 也不写 profile', async () => {
  const proposals = makeProposals([installProposal(), skillProposal()])
  const { home, store } = await seed({ map: makeMap(), proposals })
  const result = await apply({ ids: ['install-1', 'skill-1'], store, home })
  assert.deepEqual(result.applied, [])
  assert.equal(result.warnings.length, 2)
  assert.deepEqual(await readLedgerEntries(home, result.snapshotId), [])
  assert.equal(await exists(join(home, 'packs')), false)
  assert.equal(await exists(join(home, 'profiles')), false)
})

test('apply：多个 pack 提案按 ids 顺序写文件并记账，applied 顺序与 ids 一致', async () => {
  const first = makePack()
  const secondPack = makePack(makeMap(), ['deliver'], '交付助手包')
  const second = packProposalFor(secondPack)
  const firstProposal = packProposalFor(first)
  const proposals = makeProposals([firstProposal, second])
  const { home, store } = await seed({ map: makeMap(), proposals, packs: packsDoc(first, secondPack) })
  const result = await apply({ ids: [second.id, firstProposal.id], store, home })
  assert.deepEqual(result.applied, [second.id, firstProposal.id])
  const paths = await readLedgerPaths(home, result.snapshotId)
  assert.equal(paths.length, 2)
  const titles = []
  for (const file of paths) titles.push(JSON.parse(await readFile(file, 'utf8')).title)
  assert.deepEqual(titles, ['交付助手包', '研发助手包'])
})

test('apply：未知提案 id 抛 ApplyError，且不创建快照、不写包（校验在任何写之前）', async () => {
  const proposals = makeProposals([packProposal()])
  const { home, store } = await seed({ map: makeMap(), proposals })
  const before = await tree(home)
  const error = await apply({ ids: ['pack-1', 'ghost'], store, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.match(error.message, /ghost/)
  assert.deepEqual(await store.listSnapshots(), [])
  assert.deepEqual(await tree(home), before)
  assert.equal(await exists(join(home, 'packs')), false)
})

test('apply：proposals 缺失/损坏/形状不符都抛 ApplyError 且不写盘', async () => {
  // 缺失
  const missing = await seed({ map: makeMap() })
  let before = await tree(missing.home)
  await assert.rejects(apply({ ids: ['pack-1'], store: missing.store, home: missing.home }), (error) => {
    assert.ok(error instanceof ApplyError)
    assert.match(error.message, /提案/)
    return true
  })
  assert.deepEqual(await tree(missing.home), before)
  assert.deepEqual(await missing.store.listSnapshots(), [])

  // JSON 损坏
  const corrupt = await seed({ map: makeMap() })
  await writeFile(join(corrupt.home, 'proposals.json'), '{ broken json')
  before = await tree(corrupt.home)
  await assert.rejects(apply({ ids: ['pack-1'], store: corrupt.store, home: corrupt.home }), ApplyError)
  assert.deepEqual(await tree(corrupt.home), before)
  assert.deepEqual(await corrupt.store.listSnapshots(), [])

  // 形状不符（未知 kind）
  const invalid = await seed({ map: makeMap(), proposals: makeProposals([{ ...packProposal(), kind: 'other' }]) })
  before = await tree(invalid.home)
  const error = await apply({ ids: ['pack-1'], store: invalid.store, home: invalid.home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.match(error.message, /提案/)
  assert.deepEqual(await tree(invalid.home), before)
  assert.deepEqual(await invalid.store.listSnapshots(), [])
})

test('F2：store(packs) 缺失或文档损坏时 apply 抛可读 ApplyError，不创建快照不写盘', async () => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const proposals = makeProposals([proposal])
  // 缺失 → PACK_NOT_FOUND
  const missing = await seed({ proposals })
  let before = await tree(missing.home)
  const missingError = await apply({ ids: [proposal.id], store: missing.store, home: missing.home }).then(() => null, (err) => err)
  assert.ok(missingError instanceof ApplyError)
  assert.equal(missingError.code, 'PACK_NOT_FOUND')
  assert.match(missingError.message, /能力包/)
  assert.deepEqual(await tree(missing.home), before)
  assert.deepEqual(await missing.store.listSnapshots(), [])
  // JSON 损坏 → PACKS_INVALID
  const corrupt = await seed({ proposals })
  await writeFile(join(corrupt.home, 'packs.json'), '{ broken json')
  before = await tree(corrupt.home)
  const corruptError = await apply({ ids: [proposal.id], store: corrupt.store, home: corrupt.home }).then(() => null, (err) => err)
  assert.ok(corruptError instanceof ApplyError)
  assert.equal(corruptError.code, 'PACKS_INVALID')
  assert.deepEqual(await tree(corrupt.home), before)
  // 形状不符 → PACKS_INVALID
  const invalid = await seed({ proposals, packs: { packs: 'nope' } })
  before = await tree(invalid.home)
  const invalidError = await apply({ ids: [proposal.id], store: invalid.store, home: invalid.home }).then(() => null, (err) => err)
  assert.ok(invalidError instanceof ApplyError)
  assert.equal(invalidError.code, 'PACKS_INVALID')
  assert.deepEqual(await tree(invalid.home), before)
  assert.deepEqual(await invalid.store.listSnapshots(), [])
})

test('F2：提案 id 在 store(packs) 里找不到时 PACK_NOT_FOUND（不按当前地图重建），不创建快照', async () => {
  const stored = makePack()
  const other = makePack(makeMap(), ['deliver'], '另一个包')
  const proposal = packProposalFor(stored)
  const proposals = makeProposals([proposal])
  const { home, store } = await seed({ map: makeMap(), proposals, packs: packsDoc(other) })
  const before = await tree(home)
  const error = await apply({ ids: [proposal.id], store, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'PACK_NOT_FOUND')
  assert.match(error.message, /能力包/)
  assert.deepEqual(await tree(home), before)
  assert.deepEqual(await store.listSnapshots(), [])
  assert.equal(await exists(join(home, 'packs')), false)
})

test('F2：store(packs) 里的包未通过 schemas.pack → PACKS_INVALID，不创建快照', async () => {
  const good = makePack()
  const proposal = packProposalFor(good)
  const bad = { ...good, version: 2 }
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(bad) })
  const before = await tree(home)
  const error = await apply({ ids: [proposal.id], store, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'PACKS_INVALID')
  assert.match(error.message, /version/)
  assert.deepEqual(await tree(home), before)
  assert.deepEqual(await store.listSnapshots(), [])
})

test('apply：store.snapshot 返回非法快照 id 时拒绝（对齐 rollback 的 SNAPSHOT_ID 校验），不写任何包', async () => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const proposals = makeProposals([proposal])
  const { home, store } = await seed({ map: makeMap(), proposals, packs: packsDoc(pack) })
  // 防御性用例：真实 store 不会返回坏 id，只有被篡改/有 bug 的注入实现才会
  const hostile = {
    read: (name) => store.read(name),
    restore: (id) => store.restore(id),
    snapshot: async () => ({ id: '../evil', tag: 'before-apply', createdAt: '2026-11-26T00:00:00.000Z', files: [] }),
  }
  const before = await tree(home)
  const error = await apply({ ids: [proposal.id], store: hostile, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'SNAPSHOT_INVALID')
  assert.match(error.message, /快照 id/)
  assert.deepEqual(await tree(home), before)
  assert.equal(await exists(join(home, 'packs')), false)
  assert.equal(await exists(join(home, 'evil')), false)
})

test('apply：ids 缺失/为空/非法/重复都拒绝（不默认应用全部）', async () => {
  const proposals = makeProposals([packProposal()])
  const { home, store } = await seed({ map: makeMap(), proposals })
  for (const ids of [undefined, [], 'pack-1', [42], ['pack-1', 'pack-1']]) {
    await assert.rejects(apply({ ids, store, home }), ApplyError, JSON.stringify(ids))
  }
  assert.deepEqual(await store.listSnapshots(), [])
})

test('apply：先快照后写——导出失败时不留半成品 pack，但快照已创建（可回滚）', async () => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const proposals = makeProposals([proposal])
  const { home, store } = await seed({ map: makeMap(), proposals, packs: packsDoc(pack) })
  // 用同名文件占住 packs 目录，让 exportPack 在 mkdir 时真实失败（不是 mock）
  await writeFile(join(home, 'packs'), 'blocked')
  const before = await tree(home)
  const error = await apply({ ids: [proposal.id], store, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'APPLY_WRITE_FAILED')
  assert.match(error.message, /能力包|失败/)
  assert.match(error.message, /台账/)
  const snapshots = await store.listSnapshots()
  assert.equal(snapshots.length, 1)
  assert.equal(error.snapshotId, snapshots[0].id)
  assert.equal(await readFile(join(home, 'packs'), 'utf8'), 'blocked')
  assert.equal(await exists(join(home, 'snapshots', snapshots[0].id, 'packs-created.json')), false)
  const created = (await tree(home)).filter((path) => !before.includes(path))
  assert.ok(created.every((path) => path.startsWith('snapshots')), JSON.stringify(created))
  assert.deepEqual(await tempLeftovers(home), [])
  assert.deepEqual(await rollback({ snapshotId: snapshots[0].id, store, home }), { restored: true })
})

test('apply：第一个包成功、第二个包失败——清理已写文件、台账删除，快照仍可回滚', async () => {
  const firstPack = makePack()
  // 第二个包超过单文件 1MB：exportPack 在写文件前真实抛错（packs 状态由内存 store 注入）
  const bigTools = Array.from({ length: 40000 }, (_, index) => 'tool-' + index + '-' + 'x'.repeat(20))
  const secondPack = buildPack({ map: { scenarios: [], stages: [{ id: 'big', title: '大', capabilities: [], tools: bigTools }] }, stageIds: ['big'], title: '交付大包' })
  const firstProposal = packProposalFor(firstPack)
  const second = packProposalFor(secondPack)
  const proposals = makeProposals([firstProposal, second])
  const home = await makeHome()
  const realStore = createStore({ home })
  await realStore.write('proposals', proposals)
  const store = {
    read: async (name) => (name === 'packs' ? { value: packsDoc(firstPack, secondPack), error: null } : realStore.read(name)),
    write: (name, value) => realStore.write(name, value),
    snapshot: (tag) => realStore.snapshot(tag),
    restore: (id) => realStore.restore(id),
    listSnapshots: () => realStore.listSnapshots(),
  }
  const firstId = firstPack.id
  const error = await apply({ ids: [firstProposal.id, second.id], store, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'APPLY_WRITE_FAILED')
  assert.match(error.message, /写能力包失败/)
  assert.match(error.message, /台账/)
  assert.match(error.message, /1MB|上限/)
  const snapshotId = error.snapshotId
  assert.equal(typeof snapshotId, 'string')
  // 第一个包已被清理；台账被改写为空 → 删除
  assert.equal(await exists(join(home, 'packs', firstId + '.json')), false)
  assert.deepEqual(await readdir(join(home, 'packs')), [])
  assert.equal(await exists(join(home, 'snapshots', snapshotId, 'packs-created.json')), false)
  assert.deepEqual(await tempLeftovers(home), [])
  // 快照本身可用于回滚（台账缺失当空）
  assert.deepEqual(await rollback({ snapshotId, store: realStore, home }), { restored: true })
})

/* ----------------------------------------------------------------- rollback */

test('rollback：删除 apply 创建的 pack 文件并恢复状态，重复调用幂等', async () => {
  const storedPack = makePack()
  const packProposalItem = packProposalFor(storedPack)
  const proposals = makeProposals([packProposalItem, installProposal()])
  const { home, store } = await seed({ map: makeMap(), proposals, packs: packsDoc(storedPack) })
  const applied = await apply({ ids: [packProposalItem.id, 'install-1'], store, home })
  const ledgerPath = join(home, 'snapshots', applied.snapshotId, 'packs-created.json')
  const paths = await readLedgerPaths(home, applied.snapshotId)
  assert.equal(paths.length, 1)
  const packPath = paths[0]
  assert.equal(await exists(packPath), true)
  // 模拟应用后又产生的新状态：回滚应恢复快照里的提案
  await store.write('proposals', makeProposals([installProposal({ id: 'install-2' })]))
  assert.deepEqual(await rollback({ snapshotId: applied.snapshotId, store, home }), { restored: true })
  assert.equal(await exists(packPath), false)
  assert.deepEqual((await store.read('proposals')).value, proposals)
  assert.equal(await exists(ledgerPath), true)
  // 同一快照再次回滚：不报错、不产生副作用
  assert.deepEqual(await rollback({ snapshotId: applied.snapshotId, store, home }), { restored: true })
  assert.equal(await exists(packPath), false)
  assert.deepEqual(await tempLeftovers(home), [])
})

test('rollback：快照不存在时抛可读 ApplyError，不做写操作', async () => {
  const { home, store } = await seed({ map: makeMap(), proposals: makeProposals([]) })
  const before = await tree(home)
  const error = await rollback({ snapshotId: 'snapshot-20260101-000000', store, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.match(error.message, /快照/)
  assert.deepEqual(await tree(home), before)
})

test('rollback：没有记账的手工快照只恢复状态也成功（记账缺失当空）', async () => {
  const { home, store } = await seed({ map: makeMap(), proposals: makeProposals([packProposal()]) })
  const snap = await store.snapshot('manual')
  await store.write('map', { scenarios: ['changed'], stages: [] })
  assert.deepEqual(await rollback({ snapshotId: snap.id, store, home }), { restored: true })
  assert.deepEqual((await store.read('map')).value, makeMap())
})

test('rollback：记账损坏时抛 ApplyError，且不删除 pack、不恢复状态', async () => {
  const storedPack = makePack()
  const packProposalItem = packProposalFor(storedPack)
  const proposals = makeProposals([packProposalItem])
  const { home, store } = await seed({ map: makeMap(), proposals, packs: packsDoc(storedPack) })
  const applied = await apply({ ids: [packProposalItem.id], store, home })
  const ledgerPath = join(home, 'snapshots', applied.snapshotId, 'packs-created.json')
  const packPath = (await readLedgerPaths(home, applied.snapshotId))[0]
  const changed = makeProposals([installProposal({ id: 'install-2' })])
  await store.write('proposals', changed)
  const broken = [
    'not json',
    JSON.stringify({}),
    JSON.stringify({ entries: 'x' }),
    JSON.stringify({ entries: [42] }),
    JSON.stringify({ entries: [{ path: 42, existedBefore: false }] }),
    JSON.stringify({ entries: [{ path: '/tmp/x', existedBefore: 'yes' }] }),
    JSON.stringify({ paths: 'x' }),
    JSON.stringify({ paths: [42] }),
  ]
  for (const raw of broken) {
    await writeFile(ledgerPath, raw)
    const error = await rollback({ snapshotId: applied.snapshotId, store, home }).then(() => null, (err) => err)
    assert.ok(error instanceof ApplyError, raw)
    assert.match(error.message, /记账/, raw)
    assert.equal(await exists(packPath), true, raw)
    assert.deepEqual((await store.read('proposals')).value, changed, raw)
  }
})

test('rollback：记账里的路径逃出 packs 目录时拒绝删除外部文件', async () => {
  const storedPack = makePack()
  const packProposalItem = packProposalFor(storedPack)
  const proposals = makeProposals([packProposalItem])
  const { home, store } = await seed({ map: makeMap(), proposals, packs: packsDoc(storedPack) })
  const applied = await apply({ ids: [packProposalItem.id], store, home })
  const ledgerPath = join(home, 'snapshots', applied.snapshotId, 'packs-created.json')
  const packPath = (await readLedgerPaths(home, applied.snapshotId))[0]
  const outside = join(home, 'outside.json')
  await writeFile(outside, 'keep me')
  await writeFile(ledgerPath, JSON.stringify({ entries: [{ path: outside, existedBefore: false }] }))
  const error = await rollback({ snapshotId: applied.snapshotId, store, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.match(error.message, /路径|记账/)
  assert.equal(await readFile(outside, 'utf8'), 'keep me')
  assert.equal(await exists(packPath), true)
})

test('rollback：台账路径存在但类型异常（目录）时整体拒绝，不半删也不恢复', async () => {
  const firstPack = makePack()
  const secondPack = makePack(makeMap(), ['deliver'], '交付助手包')
  const firstProposal = packProposalFor(firstPack)
  const secondProposal = packProposalFor(secondPack)
  const proposals = makeProposals([firstProposal, secondProposal])
  const { home, store } = await seed({ map: makeMap(), proposals, packs: packsDoc(firstPack, secondPack) })
  const applied = await apply({ ids: [firstProposal.id, secondProposal.id], store, home })
  const paths = await readLedgerPaths(home, applied.snapshotId)
  assert.equal(paths.length, 2)
  const [firstPath, secondPath] = paths
  // 把第二个包文件换成同名目录（类型异常），并改动状态以便断言未被恢复
  await rm(secondPath, { force: true })
  await mkdir(secondPath)
  const changed = makeProposals([installProposal({ id: 'install-2' })])
  await store.write('proposals', changed)
  const error = await rollback({ snapshotId: applied.snapshotId, store, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'LEDGER_UNSAFE_PATH')
  // 预检失败 → 一个都不删、状态也没恢复
  assert.equal(await exists(firstPath), true)
  assert.equal(await exists(secondPath), true)
  assert.deepEqual((await store.read('proposals')).value, changed)
})

test('rollback：非法 snapshotId 抛 ApplyError（拒绝路径穿越，不读文件系统）', async () => {
  const { home, store } = await seed({ map: makeMap() })
  for (const snapshotId of ['../etc', '', '   ', 42, null, undefined, 'a/b']) {
    await assert.rejects(rollback({ snapshotId, store, home }), ApplyError, String(snapshotId))
  }
})

/* ------------------------------------------------- F1 覆盖回滚（修复契约 R-6B） */

/** 二次 apply 覆盖同一 pack id 的公共搭台：第一次写 v1，第二次写 v2。 */
async function seedOverwrite({ v1 = makePack(), v2 = makePack(makeMapV2()) } = {}) {
  const proposal = packProposalFor(v1)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(v1) })
  const file = join(home, 'packs', v1.id + '.json')
  const first = await apply({ ids: [proposal.id], store, home })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), v1)
  await store.write('packs', packsDoc(v2))
  const second = await apply({ ids: [proposal.id], store, home })
  assert.notEqual(second.snapshotId, first.snapshotId)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), v2)
  return { home, store, proposal, first, second, file, v1, v2 }
}

test('F1：二次 apply 覆盖旧包后回滚，恢复覆盖前内容而不是删除旧包（R-6B）', async () => {
  const { home, store, first, second, file, v1 } = await seedOverwrite()
  assert.deepEqual(await readLedgerEntries(home, second.snapshotId), [{ path: file, existedBefore: true }])
  assert.deepEqual(await rollback({ snapshotId: second.snapshotId, store, home }), { restored: true })
  const restored = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(restored, v1, '回滚必须恢复覆盖前的旧字节，不能删掉快照前已存在的包')
  // 第一份快照（该文件是第一次 apply 新建的）回滚仍然删文件
  assert.deepEqual(await readLedgerEntries(home, first.snapshotId), [{ path: file, existedBefore: false }])
  assert.deepEqual(await rollback({ snapshotId: first.snapshotId, store, home }), { restored: true })
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' })
})

test('F1：覆盖前把旧字节备份进 <快照>/packs-backup/<basename>，原子写不留 .tmp', async () => {
  const { home, second, file, v1 } = await seedOverwrite()
  const backup = join(home, 'snapshots', second.snapshotId, 'packs-backup', v1.id + '.json')
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')), v1, '备份必须是覆盖前的旧字节')
  assert.equal(await exists(join(home, 'snapshots', second.snapshotId, 'packs-backup')), true)
  assert.deepEqual(await tempLeftovers(home), [])
  // 备份小于 1MB（pack 本身受同一上限约束）
  assert.ok((await stat(backup)).size < 1024 * 1024)
  assert.equal(await exists(file), true)
})

test('F1：导出中途失败——既有文件内容不变、新建文件清理、台账删除（不留不可回滚记账）', async () => {
  const existing = makePack()
  const changed = makePack(makeMapV2())
  // 全新包超过单文件 1MB：exportPack 在写文件前真实抛错（packs 状态由内存 store 注入）
  const bigTools = Array.from({ length: 40000 }, (_, index) => 'tool-' + index + '-' + 'x'.repeat(20))
  const fresh = buildPack({ map: { scenarios: [], stages: [{ id: 'big', title: '大', capabilities: [], tools: bigTools }] }, stageIds: ['big'], title: '全新大包' })
  const existingProposal = packProposalFor(existing)
  const freshProposal = packProposalFor(fresh)
  const { home, store: realStore } = await seed({ proposals: makeProposals([existingProposal, freshProposal]), packs: packsDoc(existing) })
  await apply({ ids: [existingProposal.id], store: realStore, home })
  const existingFile = join(home, 'packs', existing.id + '.json')
  const originalBytes = await readFile(existingFile)
  // 第二次 apply：先覆盖既有包，再在全新包上失败
  const store = {
    read: async (name) => (name === 'packs' ? { value: packsDoc(changed, fresh), error: null } : realStore.read(name)),
    write: (name, value) => realStore.write(name, value),
    snapshot: (tag) => realStore.snapshot(tag),
    restore: (id) => realStore.restore(id),
    listSnapshots: () => realStore.listSnapshots(),
  }
  const error = await apply({ ids: [existingProposal.id, freshProposal.id], store, home }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'APPLY_WRITE_FAILED')
  assert.equal(typeof error.snapshotId, 'string')
  assert.deepEqual(await readFile(existingFile), originalBytes, '已有包内容必须恢复成 apply 前的字节')
  assert.equal(await exists(join(home, 'snapshots', error.snapshotId, 'packs-created.json')), false, '清理完成后台账必须删除')
  assert.deepEqual(await tempLeftovers(home), [])
  // 用错误里的快照回滚仍然安全：既有旧包不会被删
  assert.deepEqual(await rollback({ snapshotId: error.snapshotId, store: realStore, home }), { restored: true })
  assert.deepEqual(await readFile(existingFile), originalBytes)
})

test('F1：台账只覆盖本次目标——无关旧包回滚时原样保留', async () => {
  const unrelated = makePack(makeMap(), ['deliver'], '无关旧包')
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  await mkdir(join(home, 'packs'), { recursive: true })
  const unrelatedFile = join(home, 'packs', unrelated.id + '.json')
  await writeFile(unrelatedFile, JSON.stringify(unrelated, null, 2) + '\n')
  const applied = await apply({ ids: [proposal.id], store, home })
  assert.deepEqual(await readLedgerPaths(home, applied.snapshotId), [join(home, 'packs', pack.id + '.json')])
  await rollback({ snapshotId: applied.snapshotId, store, home })
  assert.deepEqual(JSON.parse(await readFile(unrelatedFile, 'utf8')), unrelated)
})

test('F1：同一快照重复回滚幂等——恢复同字节，已删除的新建文件跳过', async () => {
  const { home, store, second, file, v1 } = await seedOverwrite()
  await rollback({ snapshotId: second.snapshotId, store, home })
  const firstBytes = await readFile(file)
  assert.deepEqual(JSON.parse(firstBytes.toString('utf8')), v1)
  assert.deepEqual(await rollback({ snapshotId: second.snapshotId, store, home }), { restored: true })
  assert.deepEqual(await readFile(file), firstBytes, '重复回滚恢复同一份旧字节')
  assert.deepEqual(await tempLeftovers(home), [])
})

/* ------------------------------------------------- F2 内容一致性（修复契约 R-8A） */

test('F2：apply 导出 store(packs) 里生成时的包，而不是用当前 map 重建', async () => {
  const stored = makePack()
  const rebuiltFromChanged = makePack(makeMapV2())
  assert.equal(rebuiltFromChanged.id, stored.id, '同 id：模拟 /pack 后地图又变')
  const proposal = packProposalFor(stored)
  const { home, store } = await seed({ map: makeMapV2(), proposals: makeProposals([proposal]), packs: packsDoc(stored) })
  await apply({ ids: [proposal.id], store, home })
  const exported = JSON.parse(await readFile(join(home, 'packs', stored.id + '.json'), 'utf8'))
  assert.deepEqual(exported, stored, '导出内容必须等于 /pack 时存储的 pack（含 createdAt/工具集）')
  assert.notDeepEqual(exported.tools, rebuiltFromChanged.tools)
})

/* ------------------------------------------------- S2 技能安装（SKILL.md） */

/** 临时技能根（$DSH_HOME/skills 的等价物）。 */
async function makeSkillsHome() {
  const dir = await mkdtemp(join(tmpdir(), 'guizhi-skills-'))
  cleanup.push(dir)
  return dir
}

/** 一个真实 buildPack、非空（含工具/技能）的提案搭台 + 独立技能根。 */
async function seedSkillApply() {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const skillsHome = await makeSkillsHome()
  return { home, store, proposal, pack, skillsHome }
}

/** 从真实文件系统读技能记账条目。 */
async function readSkillsLedger(home, snapshotId) {
  const file = join(home, 'snapshots', snapshotId, 'skills-created.json')
  const doc = JSON.parse(await readFile(file, 'utf8'))
  return doc.entries
}

test('S2：提供 skillsHome 时把非空 pack 编译成 SKILL.md，返回 skills 并写技能台账', async () => {
  const { home, store, proposal, pack, skillsHome } = await seedSkillApply()
  const expected = buildPackSkill(pack)
  const result = await apply({ ids: [proposal.id], store, home, skillsHome })
  assert.deepEqual(result.applied, [proposal.id])
  const target = join(skillsHome, expected.name, 'SKILL.md')
  assert.deepEqual(result.skills, [{ name: expected.name, path: target }])
  assert.equal(await readFile(target, 'utf8'), expected.markdown)
  // 技能台账：名字、绝对路径、应用前是否存在
  assert.deepEqual(await readSkillsLedger(home, result.snapshotId), [{ name: expected.name, path: target, existedBefore: false }])
  // pack 文件与 packs 台账保持原行为
  assert.equal(await exists(join(home, 'packs', pack.id + '.json')), true)
  assert.deepEqual(await readLedgerPaths(home, result.snapshotId), [join(home, 'packs', pack.id + '.json')])
  // 原子写不留 .tmp（数据根与技能根）
  assert.deepEqual(await tempLeftovers(home), [])
  assert.deepEqual((await readdir(skillsHome, { recursive: true })).filter((path) => path.endsWith('.tmp')), [])
})

test('S2：覆盖已有 SKILL.md 前备份旧字节，rollback 恢复；重复回滚幂等', async () => {
  const { home, store, proposal, pack, skillsHome } = await seedSkillApply()
  const expected = buildPackSkill(pack)
  const target = join(skillsHome, expected.name, 'SKILL.md')
  await mkdir(join(skillsHome, expected.name), { recursive: true })
  const oldBytes = Buffer.from('# 旧技能\n旧内容\n', 'utf8')
  await writeFile(target, oldBytes)
  const applied = await apply({ ids: [proposal.id], store, home, skillsHome })
  assert.equal(await readFile(target, 'utf8'), expected.markdown, 'apply 覆盖旧技能')
  assert.deepEqual(await readSkillsLedger(home, applied.snapshotId), [{ name: expected.name, path: target, existedBefore: true }])
  const backup = join(home, 'snapshots', applied.snapshotId, 'skills-backup', expected.name, 'SKILL.md')
  assert.deepEqual(await readFile(backup), oldBytes, '备份必须是覆盖前的旧字节')
  assert.deepEqual(await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome }), { restored: true })
  assert.deepEqual(await readFile(target), oldBytes, '回滚必须恢复旧字节，不能删除快照前已存在的技能')
  assert.deepEqual(await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome }), { restored: true })
  assert.deepEqual(await readFile(target), oldBytes, '重复回滚恢复同一份旧字节')
  assert.deepEqual(await tempLeftovers(home), [])
})

test('S2：rollback 删除本次新建的 SKILL.md 并尽量移除空目录；技能根保留', async () => {
  const { home, store, proposal, pack, skillsHome } = await seedSkillApply()
  const expected = buildPackSkill(pack)
  const target = join(skillsHome, expected.name, 'SKILL.md')
  const applied = await apply({ ids: [proposal.id], store, home, skillsHome })
  assert.equal(await exists(target), true)
  assert.deepEqual(await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome }), { restored: true })
  assert.equal(await exists(target), false)
  assert.equal(await exists(join(skillsHome, expected.name)), false, '空技能目录应被移除')
  assert.equal(await exists(skillsHome), true, '共享技能根本身必须保留')
  assert.deepEqual(await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome }), { restored: true })
})

test('S2：不传 skillsHome 保持旧行为——不安装技能、不追加 warning、skills 为空', async () => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const result = await apply({ ids: [proposal.id], store, home })
  assert.deepEqual(result.applied, [proposal.id])
  assert.deepEqual(result.skills, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(await exists(join(home, 'snapshots', result.snapshotId, 'skills-created.json')), false)
  assert.equal(await exists(join(home, 'snapshots', result.snapshotId, 'skills-backup')), false)
})

test('S2：空 pack 有 skillsHome 时跳过技能安装并追加 warning，pack 文件仍导出', async () => {
  const map = { scenarios: ['dev'], stages: [{ id: 'idle', title: '空闲', capabilities: [] }] }
  const pack = buildPack({ map, stageIds: ['idle'], title: '空包' })
  const proposal = packProposalFor(pack)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const skillsHome = await makeSkillsHome()
  const result = await apply({ ids: [proposal.id], store, home, skillsHome })
  assert.deepEqual(result.applied, [proposal.id], 'pack 文件照旧导出')
  assert.deepEqual(result.skills, [])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /没有工具\/技能/)
  assert.match(result.warnings[0], /跳过技能安装/)
  assert.equal(await exists(join(home, 'packs', pack.id + '.json')), true)
  assert.equal(await exists(join(home, 'snapshots', result.snapshotId, 'skills-created.json')), false)
  assert.deepEqual(await readdir(skillsHome), [], '空包不得写出技能目录')
})

test('S2：skillsHome 非空字符串之外的输入在快照前拒绝，不写盘', async () => {
  const { home, store, proposal } = await seedSkillApply()
  const before = await tree(home)
  for (const skillsHome of ['', '   ', 42, {}, []]) {
    const error = await apply({ ids: [proposal.id], store, home, skillsHome }).then(() => null, (err) => err)
    assert.ok(error instanceof ApplyError, String(skillsHome))
    assert.equal(error.code, 'INVALID_INPUT', String(skillsHome))
    assert.deepEqual(await tree(home), before)
    assert.deepEqual(await store.listSnapshots(), [])
  }
})

test('S2：存储 pack 的 id 不能作为技能名时在快照前拒绝，不写出任何文件', async () => {
  // 安全文件名但非法 kebab 技能名：只有 opt-in 安装技能时才在规划阶段拒绝
  const bad = { ...makePack(), id: 'Pack_Bad' }
  const proposal = packProposalFor(bad)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(bad) })
  const skillsHome = await makeSkillsHome()
  const before = await tree(home)
  const error = await apply({ ids: [proposal.id], store, home, skillsHome }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'PACK_INVALID')
  assert.match(error.message, /技能名|kebab|id/)
  assert.deepEqual(await tree(home), before)
  assert.deepEqual(await store.listSnapshots(), [])
  assert.deepEqual(await readdir(skillsHome), [])
})

test('S2：技能目标已存在但不是普通文件时在快照前拒绝，不覆盖也不建快照', async () => {
  const { home, store, proposal, pack, skillsHome } = await seedSkillApply()
  const expected = buildPackSkill(pack)
  const target = join(skillsHome, expected.name, 'SKILL.md')
  await mkdir(target, { recursive: true })
  const before = await tree(home)
  const error = await apply({ ids: [proposal.id], store, home, skillsHome }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'SKILL_TARGET_UNSAFE')
  assert.deepEqual(await tree(home), before)
  assert.deepEqual(await store.listSnapshots(), [])
  assert.equal((await stat(target)).isDirectory(), true)
})

test('S2：技能记账损坏或路径逃逸时拒绝回滚（4xx 语义），不动文件也不恢复状态', async () => {
  const { home, store, proposal, pack, skillsHome } = await seedSkillApply()
  const expected = buildPackSkill(pack)
  const applied = await apply({ ids: [proposal.id], store, home, skillsHome })
  const ledgerFile = join(home, 'snapshots', applied.snapshotId, 'skills-created.json')
  const skillPath = join(skillsHome, expected.name, 'SKILL.md')
  const outside = join(skillsHome, '..', 'outside-skill.txt')
  await writeFile(outside, 'keep me')
  const changed = makeProposals([installProposal({ id: 'install-2' })])
  await store.write('proposals', changed)
  const broken = [
    ['not json', 'LEDGER_CORRUPT', /记账/],
    [JSON.stringify({}), 'LEDGER_CORRUPT', /记账/],
    [JSON.stringify({ entries: 'x' }), 'LEDGER_CORRUPT', /记账/],
    [JSON.stringify({ entries: [{ name: '../evil', path: skillPath, existedBefore: false }] }), 'LEDGER_CORRUPT', /记账/],
    [JSON.stringify({ entries: [{ name: expected.name, path: outside, existedBefore: false }] }), 'LEDGER_UNSAFE_PATH', /路径/],
    [
      JSON.stringify({ entries: [{ name: expected.name, path: join(skillsHome, 'other-skill', 'SKILL.md'), existedBefore: false }] }),
      'LEDGER_CORRUPT',
      /记账/,
    ],
  ]
  for (const [raw, code, pattern] of broken) {
    await writeFile(ledgerFile, raw)
    const error = await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome }).then(() => null, (err) => err)
    assert.ok(error instanceof ApplyError, raw)
    assert.equal(error.code, code, raw)
    assert.match(error.message, pattern, raw)
    assert.equal(await exists(skillPath), true, raw)
    assert.equal(await readFile(outside, 'utf8'), 'keep me', raw)
    assert.deepEqual((await store.read('proposals')).value, changed, raw)
  }
  // existedBefore=true 但没有备份 → 拒绝半恢复
  await writeFile(ledgerFile, JSON.stringify({ entries: [{ name: expected.name, path: skillPath, existedBefore: true }] }))
  const missingBackup = await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome }).then(() => null, (err) => err)
  assert.ok(missingBackup instanceof ApplyError)
  assert.equal(missingBackup.code, 'ROLLBACK_BACKUP_MISSING')
  assert.equal(await exists(skillPath), true)
  // 快照里有技能记账但没传 skillsHome：拒绝而不是假装回滚
  await writeFile(ledgerFile, JSON.stringify({ entries: [{ name: expected.name, path: skillPath, existedBefore: false }] }))
  const noHome = await rollback({ snapshotId: applied.snapshotId, store, home }).then(() => null, (err) => err)
  assert.ok(noHome instanceof ApplyError)
  assert.equal(noHome.code, 'INVALID_INPUT')
  assert.equal(await exists(skillPath), true)
  assert.deepEqual((await store.read('proposals')).value, changed, '拒绝时不得恢复状态')
})

test('S2：pack 导出失败时清理已导出的包并收敛台账；技能部分尚未开始（旧技能不被覆盖）', async () => {
  const firstPack = makePack()
  const firstProposal = packProposalFor(firstPack)
  // 第二个包超过单文件 1MB：pack 状态文档由内存 store 注入（真实 store.write 也有 1MB 上限）
  const bigTools = Array.from({ length: 40000 }, (_, index) => 'tool-' + index + '-' + 'x'.repeat(20))
  const bigPack = buildPack({ map: { scenarios: [], stages: [{ id: 'big', title: '大', capabilities: [], tools: bigTools }] }, stageIds: ['big'], title: '大包' })
  const failingProposal = packProposalFor(bigPack)
  const home = await makeHome()
  const realStore = createStore({ home })
  await realStore.write('proposals', makeProposals([firstProposal, failingProposal]))
  const store = {
    read: async (name) => (name === 'packs' ? { value: packsDoc(firstPack, bigPack), error: null } : realStore.read(name)),
    write: (name, value) => realStore.write(name, value),
    snapshot: (tag) => realStore.snapshot(tag),
    restore: (id) => realStore.restore(id),
    listSnapshots: () => realStore.listSnapshots(),
  }
  const skillsHome = await makeSkillsHome()
  const expected = buildPackSkill(firstPack)
  const target = join(skillsHome, expected.name, 'SKILL.md')
  await mkdir(join(skillsHome, expected.name), { recursive: true })
  const oldBytes = Buffer.from('# 旧技能\n保留我\n', 'utf8')
  await writeFile(target, oldBytes)
  const error = await apply({ ids: [firstProposal.id, failingProposal.id], store, home, skillsHome }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'APPLY_WRITE_FAILED')
  assert.match(error.message, /1MB|上限/)
  assert.equal(typeof error.snapshotId, 'string')
  assert.equal(await exists(join(home, 'packs', firstPack.id + '.json')), false, '已导出的第一个包必须被清理')
  assert.deepEqual(await readFile(target), oldBytes, '技能写入尚未开始，旧技能字节必须原样保留')
  assert.equal(await exists(join(home, 'snapshots', error.snapshotId, 'packs-created.json')), false, 'packs 台账收敛后删除')
  assert.equal(await exists(join(home, 'snapshots', error.snapshotId, 'skills-created.json')), false, '技能阶段未开始，不得有技能台账')
  assert.deepEqual(await tempLeftovers(home), [])
})

test('S2：旧快照没有技能记账时 rollback 传 skillsHome 也跳过技能部分（兼容）', async () => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const applied = await apply({ ids: [proposal.id], store, home })
  const skillsHome = await makeSkillsHome()
  assert.deepEqual(await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome }), { restored: true })
  assert.deepEqual(await readdir(skillsHome), [])
})

/* ------------------------------------------------- S2 加固（opt-in / 根 / 台账安全） */

/** Windows 上普通符号链接需要额外权限；目录 junction 不需要，POSIX 会忽略 type。 */
async function makeDirLink(target, link) {
  try {
    await symlink(target, link, 'junction')
    return true
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EINVAL') return false
    throw error
  }
}

/** 包一层 store：snapshot 成功后执行侧效应，模拟「快照之后技能目标被换掉」。 */
function storeWithSnapshotHook(store, hook) {
  return {
    read: (name) => store.read(name),
    write: (name, value) => store.write(name, value),
    snapshot: async (tag) => {
      const snapshot = await store.snapshot(tag)
      await hook(snapshot)
      return snapshot
    },
    restore: (id) => store.restore(id),
    listSnapshots: () => store.listSnapshots(),
  }
}

test('S2 加固：不安全的 pack id 在快照前拒绝 PACK_INVALID——没有 skillsHome 也拒绝', async () => {
  for (const id of ['../escape', 'a/b', 'a' + String.fromCharCode(92) + 'b', '..', '.']) {
    const bad = { ...makePack(), id }
    const proposal = packProposalFor(bad)
    const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(bad) })
    const before = await tree(home)
    const error = await apply({ ids: [proposal.id], store, home }).then(() => null, (err) => err)
    assert.ok(error instanceof ApplyError, JSON.stringify(id))
    assert.equal(error.code, 'PACK_INVALID', JSON.stringify(id))
    assert.deepEqual(await tree(home), before, JSON.stringify(id))
    assert.deepEqual(await store.listSnapshots(), [], JSON.stringify(id))
  }
})

test('S2 加固：pack id 可作安全文件名但不是合法技能名时，不传 skillsHome 仍只导出清单', async () => {
  const bad = { ...makePack(), id: 'Pack_Bad' }
  const proposal = packProposalFor(bad)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(bad) })
  const result = await apply({ ids: [proposal.id], store, home })
  assert.deepEqual(result.applied, [proposal.id])
  assert.deepEqual(result.skills, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(await exists(join(home, 'packs', bad.id + '.json')), true)
})

test('S2 加固：skillsHome 本身是符号链接（dotfiles）时按规范根安装并回滚', async (t) => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const parent = await mkdtemp(join(tmpdir(), 'guizhi-skills-link-'))
  cleanup.push(parent)
  const realSkills = join(parent, 'real-skills')
  await mkdir(realSkills, { recursive: true })
  const linkedSkills = join(parent, 'skills')
  if (!(await makeDirLink(realSkills, linkedSkills))) {
    t.skip('当前环境不能创建目录符号链接')
    return
  }
  const canonicalRoot = await realpath(linkedSkills)
  const expected = buildPackSkill(pack)
  const target = join(canonicalRoot, expected.name, 'SKILL.md')
  const result = await apply({ ids: [proposal.id], store, home, skillsHome: linkedSkills })
  assert.deepEqual(result.skills, [{ name: expected.name, path: target }])
  assert.equal(await readFile(target, 'utf8'), expected.markdown)
  // 记账写规范路径：rollback 用同一个（符号链接）skillsHome 也能对上
  assert.deepEqual(await readSkillsLedger(home, result.snapshotId), [{ name: expected.name, path: target, existedBefore: false }])
  assert.deepEqual(await rollback({ snapshotId: result.snapshotId, store, home, skillsHome: linkedSkills }), { restored: true })
  assert.equal(await exists(target), false)
  assert.equal(await exists(realSkills), true, '规范技能根本身必须保留')
})

test('S2 加固：skillsHome 不可用（是普通文件 / 父路径是文件）时跳过技能安装并 warning，装配清单仍导出', async () => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const parent = await mkdtemp(join(tmpdir(), 'guizhi-skills-root-'))
  cleanup.push(parent)
  const asFile = join(parent, 'skills')
  await writeFile(asFile, 'not a directory')
  for (const skillsHome of [asFile, join(asFile, 'nested')]) {
    const result = await apply({ ids: [proposal.id], store, home, skillsHome })
    assert.deepEqual(result.applied, [proposal.id])
    assert.deepEqual(result.skills, [], String(skillsHome))
    assert.equal(result.warnings.length, 1, JSON.stringify(result.warnings))
    assert.match(result.warnings[0], /技能安装已跳过/)
    assert.match(result.warnings[0], /装配清单已导出/)
    assert.equal(await exists(join(home, 'packs', pack.id + '.json')), true)
    assert.equal(await exists(join(home, 'snapshots', result.snapshotId, 'skills-created.json')), false)
  }
})

test('S2 加固：技能目录是符号链接时在快照前拒绝 SKILL_TARGET_UNSAFE，不写快照也不写外部目录', async (t) => {
  const { home, store, proposal, pack, skillsHome } = await seedSkillApply()
  const expected = buildPackSkill(pack)
  const outsideParent = await mkdtemp(join(tmpdir(), 'guizhi-skills-outside-'))
  cleanup.push(outsideParent)
  const outside = join(outsideParent, 'escaped')
  await mkdir(outside, { recursive: true })
  if (!(await makeDirLink(outside, join(skillsHome, expected.name)))) {
    t.skip('当前环境不能创建目录符号链接')
    return
  }
  const before = await tree(home)
  const error = await apply({ ids: [proposal.id], store, home, skillsHome }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'SKILL_TARGET_UNSAFE')
  assert.match(error.message, /符号链接|父目录|拒绝/)
  assert.deepEqual(await tree(home), before)
  assert.deepEqual(await store.listSnapshots(), [])
  assert.deepEqual(await readdir(outside), [], '外部目录不得被写入')
})

test('S2 加固：快照后技能目录被换成逃逸符号链接——拒绝写入外部，warning、pack 保留', async (t) => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store: realStore } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const skillsHome = await makeSkillsHome()
  const expected = buildPackSkill(pack)
  const skillDir = join(skillsHome, expected.name)
  const outsideParent = await mkdtemp(join(tmpdir(), 'guizhi-skills-swap-'))
  cleanup.push(outsideParent)
  const outside = join(outsideParent, 'escaped')
  await mkdir(outside, { recursive: true })
  let linkReady = true
  const store = storeWithSnapshotHook(realStore, async () => {
    linkReady = await makeDirLink(outside, skillDir)
  })
  const result = await apply({ ids: [proposal.id], store, home, skillsHome })
  if (!linkReady) {
    t.skip('当前环境不能创建目录符号链接')
    return
  }
  assert.deepEqual(result.applied, [proposal.id])
  assert.deepEqual(result.skills, [])
  const warning = result.warnings.find((message) => /技能安装失败/.test(message))
  assert.ok(warning !== undefined, JSON.stringify(result.warnings))
  assert.match(warning, /装配清单已导出/)
  assert.equal(await exists(join(home, 'packs', pack.id + '.json')), true, '已导出 pack 必须保留')
  assert.equal(await exists(join(home, 'snapshots', result.snapshotId, 'skills-created.json')), false, '技能台账必须收敛删除')
  assert.deepEqual(await readdir(outside), [], '外部目录不得被写入')
  assert.deepEqual(await rollback({ snapshotId: result.snapshotId, store: realStore, home, skillsHome }), { restored: true })
  assert.equal(await exists(join(home, 'packs', pack.id + '.json')), false)
  assert.deepEqual(await readdir(outside), [])
})

test('S2 加固：快照后技能目录被换成普通文件——技能安装失败降级 warning，pack 保留，回滚只回滚 pack', async () => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store: realStore } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const skillsHome = await makeSkillsHome()
  const expected = buildPackSkill(pack)
  const skillDir = join(skillsHome, expected.name)
  const store = storeWithSnapshotHook(realStore, async () => {
    await writeFile(skillDir, 'blocked by test')
  })
  const result = await apply({ ids: [proposal.id], store, home, skillsHome })
  assert.deepEqual(result.applied, [proposal.id])
  assert.deepEqual(result.skills, [])
  const warning = result.warnings.find((message) => /技能安装失败/.test(message))
  assert.ok(warning !== undefined, JSON.stringify(result.warnings))
  assert.match(warning, /装配清单已导出/)
  assert.equal(await exists(join(home, 'packs', pack.id + '.json')), true, '已导出 pack 必须保留')
  assert.equal(await exists(join(home, 'snapshots', result.snapshotId, 'skills-created.json')), false, '技能台账必须收敛删除')
  assert.equal(await readFile(skillDir, 'utf8'), 'blocked by test', '占位文件不得被覆盖')
  assert.deepEqual(await rollback({ snapshotId: result.snapshotId, store: realStore, home, skillsHome }), { restored: true })
  assert.equal(await exists(join(home, 'packs', pack.id + '.json')), false)
  assert.equal(await readFile(skillDir, 'utf8'), 'blocked by test')
})

test('S2 加固：旧快照没有技能记账时，skillsHome 不可用不影响回滚（不检查技能根）', async () => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const applied = await apply({ ids: [proposal.id], store, home })
  const parent = await mkdtemp(join(tmpdir(), 'guizhi-skills-rollback-'))
  cleanup.push(parent)
  const asFile = join(parent, 'skills')
  await writeFile(asFile, 'not a directory')
  for (const skillsHome of [asFile, join(asFile, 'nested'), join(parent, 'missing-root')]) {
    assert.deepEqual(await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome }), { restored: true }, String(skillsHome))
  }
  assert.equal(await exists(join(home, 'packs', pack.id + '.json')), false)
})

test('S2 加固：技能记账 entries 为空时不要求 skillsHome', async () => {
  const pack = makePack()
  const proposal = packProposalFor(pack)
  const { home, store } = await seed({ proposals: makeProposals([proposal]), packs: packsDoc(pack) })
  const applied = await apply({ ids: [proposal.id], store, home })
  await writeFile(join(home, 'snapshots', applied.snapshotId, 'skills-created.json'), JSON.stringify({ entries: [] }))
  assert.deepEqual(await rollback({ snapshotId: applied.snapshotId, store, home }), { restored: true })
  assert.equal(await exists(join(home, 'packs', pack.id + '.json')), false)
})

test('S2 加固：技能台账 entry.name 必须以 stow- 开头且是合法 kebab，否则拒绝回滚且不动用户技能', async () => {
  const { home, store, proposal, pack, skillsHome } = await seedSkillApply()
  const expected = buildPackSkill(pack)
  const applied = await apply({ ids: [proposal.id], store, home, skillsHome })
  const ledgerFile = join(home, 'snapshots', applied.snapshotId, 'skills-created.json')
  const userDir = join(skillsHome, 'user-skill')
  await mkdir(userDir, { recursive: true })
  const userFile = join(userDir, 'SKILL.md')
  await writeFile(userFile, 'keep me')
  const installed = join(skillsHome, expected.name, 'SKILL.md')
  const tampered = [
    { name: 'user-skill', path: userFile, existedBefore: false },
    { name: 'stow_bad', path: join(skillsHome, 'stow_bad', 'SKILL.md'), existedBefore: false },
    { name: 'stowok', path: join(skillsHome, 'stowok', 'SKILL.md'), existedBefore: false },
  ]
  for (const entry of tampered) {
    await writeFile(ledgerFile, JSON.stringify({ entries: [entry] }))
    const error = await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome }).then(() => null, (err) => err)
    assert.ok(error instanceof ApplyError, entry.name)
    assert.equal(error.code, 'LEDGER_CORRUPT', entry.name)
    assert.equal(await readFile(userFile, 'utf8'), 'keep me', '用户技能不得被删除')
    assert.equal(await exists(installed), true, '本次安装的技能不得被半删')
  }
})

test('S2 加固：技能记账非空但 skillsHome 不可用时拒绝回滚（可读 500），不恢复状态', async () => {
  const { home, store, proposal, skillsHome } = await seedSkillApply()
  const applied = await apply({ ids: [proposal.id], store, home, skillsHome })
  const changed = makeProposals([installProposal({ id: 'install-2' })])
  await store.write('proposals', changed)
  const parent = await mkdtemp(join(tmpdir(), 'guizhi-skills-broken-'))
  cleanup.push(parent)
  const asFile = join(parent, 'skills')
  await writeFile(asFile, 'not a directory')
  const error = await rollback({ snapshotId: applied.snapshotId, store, home, skillsHome: asFile }).then(() => null, (err) => err)
  assert.ok(error instanceof ApplyError)
  assert.equal(error.code, 'ROLLBACK_RESTORE_FAILED')
  assert.match(error.message, /技能根|skillsHome/)
  assert.deepEqual((await store.read('proposals')).value, changed, '拒绝时不得恢复状态')
})
