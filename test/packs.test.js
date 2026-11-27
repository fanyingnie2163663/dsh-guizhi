import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schemas } from '../lib/schemas.js'
import { buildPack, exportPack, isPackEmpty, isSafePackId, validatePack } from '../lib/packs.js'

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

/**
 * 一个合法 D7 map stage（R-4A：封闭的 stage 形状新增可选 tools/skills）。
 * overrides 用来挂合并来源或非法值；fixture 由 schemas.map.validate 把关。
 */
function stage(overrides = {}) {
  return { id: 'understand', title: '理解需求', capabilities: [], ...overrides }
}

/** 两阶段合法 D7 map：工具/技能有重名，用来验证去重与首现顺序。 */
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

test('buildPack fixture：合法的 D7 map 通过 schemas.map.validate', () => {
  assert.deepEqual(schemas.map.validate(makeMap()), { ok: true, errors: [] })
})

test('buildPack：合法 D7 map（带 capabilities/evidence 与 tools/skills）能构建包', () => {
  const map = {
    scenarios: ['dev'],
    stages: [
      {
        id: 'understand',
        title: '理解需求',
        capabilities: [
          { id: 'read-code', title: '读代码', status: 'have', evidence: { source: 'scan', tools: ['read'] } },
          { id: 'search-web', title: '查资料', status: 'missing', evidence: { source: 'catalog' } },
        ],
        tools: ['read'],
        skills: ['brainstorming'],
      },
      {
        id: 'deliver',
        title: '交付',
        capabilities: [],
        tools: ['read', 'edit'],
        skills: ['writing'],
      },
    ],
  }
  assert.deepEqual(schemas.map.validate(map), { ok: true, errors: [] })
  const pack = buildPack({ map, stageIds: ['understand', 'deliver'], title: '研发助手包' })
  assert.deepEqual(pack.tools, ['read', 'edit'])
  assert.deepEqual(pack.skills, ['brainstorming', 'writing'])
  assert.deepEqual(pack.rows.map((row) => row.capabilityId), ['read-code', 'search-web'], 'rows 逐能力点成行')
  assert.deepEqual(validatePack(pack), { ok: true, errors: [] })
})

test('buildPack：非法 map 被拒绝，errors 带 schema 原始错误（不再接受未校验 stage 形状）', () => {
  const unknownField = makeMap()
  unknownField.stages[0].order = 1
  assert.throws(
    () => buildPack({ map: unknownField, stageIds: ['understand'], title: 't' }),
    (error) => {
      assert.equal(error.name, 'PackBuildError')
      assert.match(error.message, /地图校验失败/)
      assert.deepEqual(error.errors, schemas.map.validate(unknownField).errors)
      assert.ok(error.errors.some((message) => message.includes('未知字段')))
      return true
    },
  )

  const duplicateId = makeMap()
  duplicateId.stages[1].id = duplicateId.stages[0].id
  assert.throws(
    () => buildPack({ map: duplicateId, stageIds: ['understand'], title: 't' }),
    (error) => {
      assert.equal(error.name, 'PackBuildError')
      assert.ok(error.errors.some((message) => message.includes('重复')), JSON.stringify(error.errors))
      return true
    },
  )

  const badTools = makeMap()
  badTools.stages[0].tools = ['read', 7]
  assert.throws(() => buildPack({ map: badTools, stageIds: ['understand'], title: 't' }), /地图校验失败/)
})

test('buildPack：按 stageIds 顺序合并两阶段的 tools/skills，去重且保持首次出现顺序', () => {
  const pack = buildPack({ map: makeMap(), stageIds: ['understand', 'deliver'], title: '研发助手包' })
  assert.deepEqual(pack.tools, ['read', 'grep', 'edit'])
  assert.deepEqual(pack.skills, ['brainstorming', 'writing'])
  assert.deepEqual(pack.stageIds, ['understand', 'deliver'])
  assert.equal(pack.title, '研发助手包')
  assert.equal(pack.version, 1)
  assert.deepEqual(pack.rows, [], '没有 capability 的阶段不产生 rows')
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
  assert.deepEqual(pack.rows, [], '未选中任何阶段时不产生 rows')
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

test('buildPack：stage 未显式声明时，从 capability evidence 派生 tools/skills', () => {
  const map = {
    scenarios: ['dev'],
    stages: [
      {
        id: 'understand',
        title: '理解需求',
        capabilities: [
          {
            id: 'read-code',
            title: '读代码',
            status: 'have',
            evidence: { source: 'scan', tools: ['read', 'grep'], tool: 'glob', skills: ['brainstorming'], skill: 'writing-plans' },
          },
          { id: 'search', title: '查资料', status: 'missing', evidence: { source: 'catalog', tools: ['web_search'], skill: 'research' } },
        ],
      },
      {
        id: 'deliver',
        title: '交付',
        capabilities: [
          {
            id: 'ship',
            title: '交付能力',
            status: 'have',
            evidence: { source: 'scan', tool: 'edit', skills: ['writing-plans', 'commit'], skill: 'tdd' },
          },
        ],
      },
    ],
  }
  const pack = buildPack({ map, stageIds: ['understand', 'deliver'], title: '证据包' })
  assert.deepEqual(pack.tools, ['read', 'grep', 'glob', 'web_search', 'edit'], 'evidence.tools 数组元素 + evidence.tool 字符串，首现保序')
  assert.deepEqual(pack.skills, ['brainstorming', 'writing-plans', 'research', 'commit', 'tdd'], 'evidence.skills 数组元素 + evidence.skill 字符串')
  assert.deepEqual(validatePack(pack), { ok: true, errors: [] })
})

test('buildPack：stage 显式列表优先，再并入本阶段 evidence 派生名并全局去重', () => {
  const map = {
    scenarios: [],
    stages: [
      {
        id: 'a',
        title: 'A',
        capabilities: [
          {
            id: 'c1',
            title: 'C1',
            status: 'have',
            evidence: { tools: ['grep', 'edit'], tool: 'read', skills: ['writing'], skill: 'brainstorming' },
          },
          { id: 'c2', title: 'C2', status: 'missing', evidence: { tools: ['web_search'], skills: ['writing'] } },
        ],
        tools: ['read', 'grep'],
        skills: ['brainstorming'],
      },
      {
        id: 'b',
        title: 'B',
        capabilities: [{ id: 'c3', title: 'C3', status: 'have', evidence: { tools: ['edit', 'browser'], skills: ['tdd'] } }],
        tools: ['edit'],
      },
    ],
  }
  const pack = buildPack({ map, stageIds: ['a', 'b'], title: 't' })
  // 阶段显式 read,grep → 该阶段能力点派生 edit → 下一能力点 web_search → 阶段 b 显式/派生均重复后新增 browser
  assert.deepEqual(pack.tools, ['read', 'grep', 'edit', 'web_search', 'browser'])
  assert.deepEqual(pack.skills, ['brainstorming', 'writing', 'tdd'])
})

test('buildPack：畸形 evidence 被忽略（非数组字段、非字符串字段与元素），不抛错', () => {
  const map = {
    scenarios: [],
    stages: [
      {
        id: 's',
        title: 'S',
        capabilities: [
          { id: 'c1', title: 'C1', status: 'have', evidence: { source: 'scan', tools: 'read', tool: 7, skills: {}, skill: null } },
          {
            id: 'c2',
            title: 'C2',
            status: 'have',
            evidence: { source: 'scan', tools: ['ok', 42, null, '', ['nested']], tool: 'single', skills: ['s1', false], skill: 's2' },
          },
          { id: 'c3', title: 'C3', status: 'have', evidence: { source: 'catalog' } },
          { id: 'c4', title: 'C4', status: 'have', evidence: { tools: [undefined] } },
        ],
      },
    ],
  }
  const pack = buildPack({ map, stageIds: ['s'], title: 't' })
  assert.deepEqual(pack.tools, ['ok', '', 'single'], '只接受字符串元素与字符串字段')
  assert.deepEqual(pack.skills, ['s1', 's2'])
  assert.deepEqual(
    pack.rows.map((row) => ({ id: row.capabilityId, tools: row.tools, skills: row.skills })),
    [
      { id: 'c1', tools: [], skills: [] },
      { id: 'c2', tools: ['ok', '', 'single'], skills: ['s1', 's2'] },
      { id: 'c3', tools: [], skills: [] },
      { id: 'c4', tools: [], skills: [] },
    ],
    'rows 内同样忽略畸形值',
  )
})

test('buildPack：rows 每个选中阶段每个 capability 一行，顺序为 stageIds 顺序 × 能力点顺序', () => {
  const map = {
    scenarios: [],
    stages: [
      {
        id: 'understand',
        title: '理解需求',
        capabilities: [
          {
            id: 'read-code',
            title: '读代码',
            status: 'have',
            evidence: { tools: ['read', 'read'], tool: 'grep', skills: ['brainstorming'], skill: 'writing' },
          },
          { id: 'search', title: '查资料', status: 'missing', evidence: { source: 'catalog' } },
        ],
      },
      {
        id: 'deliver',
        title: '交付',
        capabilities: [{ id: 'ship', title: '交付能力', status: 'redundant', evidence: { tool: 'edit' } }],
      },
      { id: 'idle', title: '空闲', capabilities: [] },
    ],
  }
  const pack = buildPack({ map, stageIds: ['understand', 'idle', 'deliver'], title: 't' })
  assert.deepEqual(pack.rows, [
    {
      stageId: 'understand',
      stageTitle: '理解需求',
      capabilityId: 'read-code',
      capabilityTitle: '读代码',
      status: 'have',
      tools: ['read', 'grep'],
      skills: ['brainstorming', 'writing'],
    },
    {
      stageId: 'understand',
      stageTitle: '理解需求',
      capabilityId: 'search',
      capabilityTitle: '查资料',
      status: 'missing',
      tools: [],
      skills: [],
    },
    {
      stageId: 'deliver',
      stageTitle: '交付',
      capabilityId: 'ship',
      capabilityTitle: '交付能力',
      status: 'redundant',
      tools: ['edit'],
      skills: [],
    },
  ])
  assert.equal(
    pack.rows.some((row) => row.stageId === 'idle'),
    false,
    '没有能力点的阶段不产生 rows',
  )
  assert.deepEqual(validatePack(pack), { ok: true, errors: [] }, 'rows 形状必须被 D7 pack schema 接受')
})

test('buildPack：证据为空的地图仍生成合法空包——tools/skills 为空、rows 逐能力点成行', () => {
  const map = {
    scenarios: [],
    stages: [
      {
        id: 's',
        title: 'S',
        capabilities: [
          { id: 'c1', title: 'C1', status: 'missing', evidence: { source: 'catalog' } },
          { id: 'c2', title: 'C2', status: 'have', evidence: { source: 'scan', tools: [], skills: [] } },
        ],
      },
    ],
  }
  const pack = buildPack({ map, stageIds: ['s'], title: '空包' })
  assert.deepEqual(validatePack(pack), { ok: true, errors: [] })
  assert.deepEqual(pack.tools, [])
  assert.deepEqual(pack.skills, [])
  assert.deepEqual(pack.items, [], 'items 仍恒空')
  assert.deepEqual(pack.rows.map((row) => row.capabilityId), ['c1', 'c2'])
  assert.deepEqual(pack.rows.map((row) => row.tools), [[], []])
  assert.deepEqual(pack.rows.map((row) => row.skills), [[], []])
})

test('isPackEmpty：tools 与 skills 都为空才为 true；非 pack 输入按空处理不抛错', () => {
  const map = {
    scenarios: [],
    stages: [
      {
        id: 's',
        title: 'S',
        capabilities: [{ id: 'c1', title: 'C1', status: 'missing', evidence: { source: 'catalog' } }],
      },
    ],
  }
  const empty = buildPack({ map, stageIds: ['s'], title: 't' })
  assert.equal(isPackEmpty(empty), true)
  assert.equal(isPackEmpty({ ...empty, tools: ['read'] }), false, '有工具则非空')
  assert.equal(isPackEmpty({ ...empty, skills: ['brainstorming'] }), false, '有技能则非空')
  for (const value of [null, undefined, {}, { tools: 'read', skills: [] }, []]) {
    assert.equal(isPackEmpty(value), true, '防御性：非 pack 形状按空处理，不抛错')
  }
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
  const pack = buildPack({ map: { scenarios: [], stages: [stage({ id: 'big', tools })] }, stageIds: ['big'], title: 't' })
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
test('isSafePackId：id 必须能作为 packs/ 下的单文件名（非空、非 . / ..、不含 / 与反斜杠与 NUL）', () => {
  for (const id of ['pack-abcd1234', 'a', 'x.y', '-', '..a', 'a b', 'A_B']) {
    assert.equal(isSafePackId(id), true, JSON.stringify(id))
  }
  for (const id of ['', '.', '..', 'a/b', 'a' + String.fromCharCode(92) + 'b', 'a' + String.fromCharCode(0) + 'b', '/', 42, null, undefined, {}, []]) {
    assert.equal(isSafePackId(id), false, JSON.stringify(id))
  }
})

test('exportPack 与 apply 复用同一 id 边界：. 与 .. 也被拒绝（不落盘）', async () => {
  const home = await makeHome()
  for (const id of ['.', '..', '']) {
    const pack = { ...buildPack({ map: makeMap(), stageIds: [], title: 't' }), id }
    assert.equal(validatePack(pack).ok, true, id + '：schemas.pack 只要求字符串 id')
    await assert.rejects(exportPack({ home, pack }), /id/, id)
  }
  const entries = await readdir(join(home, 'packs')).catch(() => [])
  assert.deepEqual(entries, [])
})
