import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schemas } from '../lib/schemas.js'
import { buildPack, exportPack, validatePack } from '../lib/packs.js'

/** 测试用临时数据根，套件结束后统一删除。 */
const cleanup = []
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
})

/** 一个新的临时数据根（对应 D16 的 $DSH_HOME/guizhi），packs/ 尚不存在。 */
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-packs-'))
  cleanup.push(home)
  return home
}

/** 一个 D7 map stage 的最小形状；tools/skills 是 buildPack 的合并来源。 */
function stage(overrides = {}) {
  return { id: 'understand', title: '理解需求', capabilities: [], ...overrides }
}

/** 两阶段地图：工具/技能有重名，用来验证去重与首现顺序。 */
function makeMap() {
  return {
    scenarios: ['dev'],
    stages: [
      stage({ id: 'understand', tools: ['read', 'grep'], skills: ['brainstorming'] }),
      stage({ id: 'deliver', title: '交付', tools: ['read', 'edit'], skills: ['writing', 'brainstorming'] }),
    ],
  }
}

/** 与契约一致的确定性 id：'pack-' + sha256({title, stageIds}) 前 8 位小写 hex。 */
function expectedId(title, stageIds) {
  return 'pack-' + createHash('sha256').update(JSON.stringify({ title, stageIds })).digest('hex').slice(0, 8)
}

/** packs 目录里的原子写临时残留；目录不存在视为没有。 */
async function tempLeftovers(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return names.filter((name) => name.endsWith('.tmp'))
}

test('buildPack：按 stageIds 顺序合并两阶段的 tools/skills，去重且保持首次出现顺序', () => {
  const pack = buildPack({ map: makeMap(), stageIds: ['understand', 'deliver'], title: '研发助手包' })
  assert.deepEqual(pack.tools, ['read', 'grep', 'edit'])
  assert.deepEqual(pack.skills, ['brainstorming', 'writing'])
  assert.deepEqual(pack.stageIds, ['understand', 'deliver'])
  assert.equal(pack.title, '研发助手包')
  assert.equal(pack.version, 1)
  assert.deepEqual(pack.rows, [])
  assert.deepEqual(pack.items, [])
})

test('buildPack：stageIds 决定合并顺序，与 map.stages 的排列无关', () => {
  const pack = buildPack({ map: makeMap(), stageIds: ['deliver', 'understand'], title: 't' })
  assert.deepEqual(pack.tools, ['read', 'edit', 'grep'])
  assert.deepEqual(pack.skills, ['writing', 'brainstorming'])
  assert.deepEqual(pack.stageIds, ['deliver', 'understand'])
})

test('buildPack：requirements 默认值正确；空 stageIds 也不虚构内容', () => {
  const pack = buildPack({ map: makeMap(), stageIds: [], title: 't' })
  assert.deepEqual(pack.requirements, { appliesAt: 'new-session', ownSession: false })
  assert.deepEqual(pack.tools, [])
  assert.deepEqual(pack.skills, [])
  assert.deepEqual(pack.rows, [])
  assert.deepEqual(pack.items, [])
})

test('buildPack：id = pack- + sha256({title, stageIds}) 前 8 位小写 hex，同输入稳定', () => {
  const map = makeMap()
  const one = buildPack({ map, stageIds: ['understand', 'deliver'], title: '研发助手包' })
  const two = buildPack({ map, stageIds: ['understand', 'deliver'], title: '研发助手包' })
  assert.equal(one.id, expectedId('研发助手包', ['understand', 'deliver']))
  assert.match(one.id, /^pack-[0-9a-f]{8}$/)
  assert.equal(two.id, one.id)
  assert.equal(typeof one.createdAt, 'string')
  assert.equal(Number.isNaN(Date.parse(one.createdAt)), false)
})

test('buildPack：title 或 stageIds 不同则 id 不同（便于对账/回滚）', () => {
  const map = makeMap()
  const base = buildPack({ map, stageIds: ['understand', 'deliver'], title: '研发助手包' })
  const otherTitle = buildPack({ map, stageIds: ['understand', 'deliver'], title: '内容助手包' })
  const otherOrder = buildPack({ map, stageIds: ['deliver', 'understand'], title: '研发助手包' })
  assert.notEqual(otherTitle.id, base.id)
  assert.notEqual(otherOrder.id, base.id)
})

test('buildPack：stageIds 引用不存在的阶段时抛错，错误信息可读', () => {
  assert.throws(
    () => buildPack({ map: makeMap(), stageIds: ['understand', 'ghost'], title: 't' }),
    (error) => {
      assert.match(error.message, /ghost/)
      assert.match(error.message, /不存在/)
      return true
    },
  )
})

test('buildPack：非法输入抛可读错误，不静默补默认值', () => {
  const cases = [
    { map: null, stageIds: [], title: 't' },
    { map: {}, stageIds: [], title: 't' },
    { map: { stages: 'x' }, stageIds: [], title: 't' },
    { map: makeMap(), stageIds: 'understand', title: 't' },
    { map: makeMap(), stageIds: [42], title: 't' },
    { map: makeMap(), stageIds: [], title: 42 },
    { map: { stages: [stage({ id: 'bad', tools: 'read' })] }, stageIds: ['bad'], title: 't' },
    { map: { stages: [stage({ id: 'bad', skills: [null] })] }, stageIds: ['bad'], title: 't' },
  ]
  for (const input of cases) {
    assert.throws(() => buildPack(input), /buildPack/, JSON.stringify(input))
  }
})

test('buildPack：不改写入参', () => {
  const map = makeMap()
  const stageIds = ['understand', 'deliver']
  const mapBefore = JSON.stringify(map)
  const idsBefore = JSON.stringify(stageIds)
  const pack = buildPack({ map, stageIds, title: 't' })
  assert.equal(JSON.stringify(map), mapBefore)
  assert.equal(JSON.stringify(stageIds), idsBefore)
  assert.notStrictEqual(pack.stageIds, stageIds)
})

test('buildPack：产物通过 validatePack', () => {
  const pack = buildPack({ map: makeMap(), stageIds: ['understand'], title: 't' })
  assert.deepEqual(validatePack(pack), { ok: true, errors: [] })
})

test('validatePack：直接复用 schemas.pack.validate（同一函数，不另写形状判断）', () => {
  assert.equal(validatePack, schemas.pack.validate)
  for (const value of [null, undefined, 'pack', 42, []]) {
    const result = validatePack(value)
    assert.equal(result.ok, false, '非对象输入应判失败而不是抛错')
    assert.ok(result.errors.length > 0)
  }
})

test('exportPack：写到 <home>/packs/<id>.json，读回 JSON 等于原对象且单文件 < 1MB', async () => {
  const home = await makeHome()
  const pack = buildPack({ map: makeMap(), stageIds: ['understand', 'deliver'], title: '研发助手包' })
  const result = await exportPack({ home, pack })
  assert.deepEqual(result, { path: join(home, 'packs', pack.id + '.json') })
  const parsed = JSON.parse(await readFile(result.path, 'utf8'))
  assert.deepEqual(parsed, pack)
  assert.deepEqual(validatePack(parsed), { ok: true, errors: [] })
  const info = await stat(result.path)
  assert.ok(info.size > 0)
  assert.ok(info.size < 1024 * 1024, '单文件必须 < 1MB：' + info.size)
  assert.deepEqual(await tempLeftovers(join(home, 'packs')), [])
})

test('exportPack：导出目录不存在时创建（home 本身也可以不存在）', async () => {
  const root = await makeHome()
  const home = join(root, 'guizhi')
  const pack = buildPack({ map: makeMap(), stageIds: ['understand'], title: 't' })
  const { path } = await exportPack({ home, pack })
  assert.equal(path, join(home, 'packs', pack.id + '.json'))
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), pack)
})

test('exportPack：同 id 二次导出原子覆盖，无 .tmp 残留', async () => {
  const home = await makeHome()
  const map = makeMap()
  const first = buildPack({ map, stageIds: ['understand'], title: 't' })
  const second = buildPack({ map, stageIds: ['understand'], title: 't' })
  assert.equal(second.id, first.id)
  await exportPack({ home, pack: first })
  const { path } = await exportPack({ home, pack: second })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), second)
  assert.deepEqual(await tempLeftovers(join(home, 'packs')), [])
})

test('exportPack：不合法 pack 被拒绝，且不落盘', async () => {
  const home = await makeHome()
  const pack = buildPack({ map: makeMap(), stageIds: ['understand'], title: 't' })
  const withoutRows = { ...pack }
  delete withoutRows.rows
  const invalid = [
    null,
    { ...pack, version: 2 },
    { ...pack, requirements: { appliesAt: 'new-session', ownSession: true } },
    withoutRows,
    { ...pack, extra: true },
  ]
  for (const candidate of invalid) {
    await assert.rejects(exportPack({ home, pack: candidate }), /能力包校验失败/, JSON.stringify(candidate))
  }
  const entries = await readdir(join(home, 'packs')).catch(() => [])
  assert.deepEqual(entries, [])
})

test('exportPack：home 非法时拒绝', async () => {
  const pack = buildPack({ map: makeMap(), stageIds: ['understand'], title: 't' })
  for (const home of ['', '   ', null, undefined, 42]) {
    await assert.rejects(exportPack({ home, pack }), /home/, String(home))
  }
})

test('exportPack：超过单文件 1MB 上限的包被拒绝，不留残文件', async () => {
  const home = await makeHome()
  const tools = Array.from({ length: 40000 }, (_, index) => 'tool-' + index + '-' + 'x'.repeat(20))
  const pack = buildPack({ map: { stages: [stage({ id: 'big', tools })] }, stageIds: ['big'], title: 't' })
  assert.equal(validatePack(pack).ok, true, '夹具包本身必须合法')
  await assert.rejects(exportPack({ home, pack }), /1MB|上限/)
  const entries = await readdir(join(home, 'packs')).catch(() => [])
  assert.deepEqual(entries, [])
})

test('exportPack：id 不能作为路径逃出 packs 目录（拒绝路径穿越）', async () => {
  const home = await makeHome()
  const pack = { ...buildPack({ map: makeMap(), stageIds: [], title: 't' }), id: '../escape' }
  assert.equal(validatePack(pack).ok, true, 'schemas.pack 对 id 只要求字符串，文件名边界由 exportPack 把守')
  await assert.rejects(exportPack({ home, pack }), /id/)
})
