import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE_PATHS, TOOL_SPECS, createRoutes, registerTools } from '../lib/routes.js'
import { buildPack } from '../lib/packs.js'
import { schemas } from '../lib/schemas.js'

/**
 * Route-layer tests (Task 7). They exercise lib/routes.js with fake dependencies
 * only: a fake HostAdapter (counters + injectable warnings), an in-memory store
 * and an injected catalog loader. No DSH host, no real profile, no network and
 * no lib/index.js import (D11: the @deepseek-ai/dsh-tools edge is not loaded by
 * tests).
 */

/** Fixed clock: every scan/usage window in this suite is deterministic. */
const NOW = new Date('2026-11-26T08:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Temp data roots removed after the suite. */
const cleanup = []
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
})

/** @param {unknown} value */
function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/** ISO timestamp daysBefore(days) days before the fixed clock. */
function daysBefore(days) {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString()
}

/** A D7-valid scan document used as stored state. */
function sampleScan() {
  return {
    plugins: [{ name: 'dsh-ops', version: '0.5.6', source: 'npm' }],
    tools: [
      { name: 'read', description: 'Read a UTF-8 text file', owners: ['@deepseek-ai/dsh-tool-fs'], used30d: 4, lastUsedAt: NOW_ISO },
      { name: 'grep', description: 'Search file contents', owners: [], used30d: 0, lastUsedAt: null },
    ],
    skills: [{ name: 'brainstorming', source: 'user' }],
    totals: { plugins: 1, tools: 2, skills: 1, unusedTools: 1 },
    warnings: [],
    generatedAt: NOW_ISO,
  }
}

/** A D7-valid map with one have + one missing capability. */
function sampleMap() {
  return {
    scenarios: ['dev'],
    stages: [
      {
        id: 'understand',
        title: '理解需求',
        capabilities: [
          { id: 'read-code', title: '读代码', status: 'have', evidence: { source: 'scan', tools: ['read'] } },
          { id: 'web-search', title: '联网搜索', status: 'missing', evidence: { source: 'catalog' } },
        ],
        tools: ['read'],
        skills: ['brainstorming'],
      },
      { id: 'deliver', title: '交付', capabilities: [] },
    ],
  }
}

/** A D7-valid proposals document (one pack item, one install item). */
function sampleProposals() {
  return {
    items: [
      { id: 'pack-dev', kind: 'pack', title: '研发包', effect: '合并两个阶段', evidence: { source: 'map', refs: ['understand'] } },
      { id: 'install-web', kind: 'install', title: '安装联网插件', effect: '补齐联网能力', evidence: { source: 'catalog', refs: ['dsh-websearch'] } },
    ],
    generatedAt: NOW_ISO,
  }
}

/** In-memory store with the five-method shape createStore provides. */
function createFakeStore(initial = {}) {
  const docs = new Map()
  for (const [name, value] of Object.entries(initial)) docs.set(name, cloneJson(value))
  const writes = []
  const errors = {}
  const snapshots = []
  let sequence = 0
  const store = {
    docs,
    writes,
    errors,
    snapshots,
    async read(name) {
      if (typeof errors[name] === 'string') return { value: null, error: errors[name] }
      if (!docs.has(name)) return { value: null, error: null }
      return { value: cloneJson(docs.get(name)), error: null }
    },
    async write(name, value) {
      writes.push({ name, value: cloneJson(value) })
      docs.set(name, cloneJson(value))
    },
    async snapshot(tag = 'manual') {
      sequence += 1
      const snapshot = { id: 'snap-' + String(sequence).padStart(3, '0'), tag, createdAt: NOW_ISO, files: [] }
      snapshots.push(snapshot)
      return cloneJson(snapshot)
    },
    async restore(id) {
      throw new Error('快照不存在或元数据已损坏：' + String(id))
    },
    async listSnapshots() {
      return cloneJson(snapshots)
    },
  }
  return store
}

/**
 * Fake HostAdapter matching the createHostAdapter contract: async list methods
 * with call counters and a warnings snapshot that a test can grow mid-stream.
 * @param {{ tools?: unknown[], plugins?: unknown[], skills?: unknown[], events?: unknown[], failTools?: string, onSessionEvent?: (index: number) => void }} [options]
 */
function createFakeHost(options = {}) {
  const warnings = []
  const counts = { listTools: 0, listPlugins: 0, listSkills: 0, sessionEvents: 0 }
  /** F5：sessionEvents 收到的 sinceISO 参数（未传时记 null）。 */
  const sessionEventSince = []
  const tools =
    options.tools ??
    [
      { name: 'read', description: 'Read a UTF-8 text file', owner: '@deepseek-ai/dsh-tool-fs' },
      { name: 'grep', description: 'Search file contents', owner: '@deepseek-ai/dsh-tool-fs' },
      { name: 'stow_scan', description: 'Scan this host', owner: '@fanyingnie/dsh-guizhi' },
    ]
  const plugins = options.plugins ?? [{ name: '@fanyingnie/dsh-guizhi', version: '0.1.0', source: 'patch' }]
  const skills = options.skills ?? [{ name: 'brainstorming', source: 'user' }]
  const events =
    options.events ??
    [
      { tool: 'read', at: daysBefore(1), sessionId: 'session-1' },
      { tool: 'read', at: daysBefore(2), sessionId: 'session-2' },
      { tool: 'grep', at: daysBefore(5), sessionId: 'session-1' },
    ]
  const dispatchCalls = []
  const dispatchEvents = options.dispatchEvents ?? []
  const dispatchSupport = options.dispatchSupport ?? { available: true }
  const dispatchSessionId = options.dispatchSessionId ?? 'background-session'
  const dispatchState = { sessionsCreated: 0, prompts: 0 }
  const host = {
    counts,
    dispatchCalls,
    dispatchState,
    sessionEventSince,
    get warnings() {
      return warnings.slice()
    },
    pushWarning(message) {
      warnings.push(String(message))
    },
    async listTools() {
      counts.listTools += 1
      if (typeof options.failTools === 'string') throw new Error(options.failTools)
      return cloneJson(tools)
    },
    async listPlugins() {
      counts.listPlugins += 1
      return cloneJson(plugins)
    },
    async listSkills() {
      counts.listSkills += 1
      return cloneJson(skills)
    },
    dispatchSupport: () => cloneJson(dispatchSupport),
    async createDispatchSession() {
      dispatchState.sessionsCreated += 1
      if (typeof options.createDispatchError === 'string') throw new Error(options.createDispatchError)
      return dispatchSessionId
    },
    async promptDispatchSession(request) {
      dispatchState.prompts += 1
      dispatchCalls.push(cloneJson(request))
      if (typeof options.promptDispatchError === 'string') throw new Error(options.promptDispatchError)
      if (options.promptDispatchMissingOnce === true && dispatchState.prompts === 1) {
        throw Object.assign(new Error('session missing'), { code: 'DISPATCH_SESSION_MISSING' })
      }
    },
    async readDispatchEvents() {
      if (options.dispatchReadStatus === 'missing') return { status: 'missing' }
      if (options.dispatchReadStatus === 'unreadable' || typeof options.dispatchReadError === 'string') {
        return { status: 'unreadable', error: options.dispatchReadError ?? 'read failed' }
      }
      return { status: 'events', events: cloneJson(dispatchEvents) }
    },
    sessionEvents(sinceISO) {
      counts.sessionEvents += 1
      sessionEventSince.push(sinceISO === undefined ? null : sinceISO)
      const rows = Array.isArray(events) ? events.slice() : []
      const onEvent = typeof options.onSessionEvent === 'function' ? options.onSessionEvent : null
      return (async function* iterate() {
        for (let index = 0; index < rows.length; index += 1) {
          yield rows[index]
          if (onEvent !== null) onEvent(index + 1)
        }
      })()
    },
  }
  return host
}

/** deps with a fresh fake store/fake host and a deterministic clock. */
function makeDeps(options = {}) {
  return {
    host: options.host ?? createFakeHost(options.hostOptions ?? {}),
    store: options.store ?? createFakeStore(options.docs ?? {}),
    ...(options.home !== undefined ? { home: options.home } : {}),
    now: () => new Date(NOW),
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }
}

/** @param {{ path: string, handler: Function }[]} routes */
function routeOf(routes, path) {
  const route = routes.find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, '缺少路由 ' + path)
  return route
}

/** Call one route handler through a fresh createRoutes wiring. */
async function call(deps, path, payload) {
  return routeOf(createRoutes({ deps }), path).handler(payload)
}

/** Assert a response is a failure carrying a readable error. */
function assertFailure(response, status, pattern) {
  assert.equal(response.status, status, '状态码应为 ' + status + '，实际 ' + response.status + '：' + JSON.stringify(response.json))
  assert.equal(typeof response.json?.error, 'string', '失败必须带可读 error')
  assert.ok(response.json.error.length > 0)
  if (pattern !== undefined) assert.match(response.json.error, pattern)
  return response
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

test('路由表：11 条 root-absolute /api/guizhi 路由，方法与 ROUTE_PATHS 一一对应', () => {
  const routes = createRoutes({ deps: makeDeps() })
  assert.equal(routes.length, 11)
  for (const route of routes) {
    assert.ok(route.method === 'GET' || route.method === 'POST', 'method 只能是 GET/POST')
    assert.equal(typeof route.path, 'string')
    assert.ok(route.path.startsWith('/api/guizhi/'), '路由必须 root-absolute：' + route.path)
    assert.equal(typeof route.handler, 'function')
  }
  assert.deepEqual(routes.map((route) => route.path).sort(), Object.values(ROUTE_PATHS).sort())
  assert.equal(routeOf(routes, ROUTE_PATHS.state).method, 'GET')
  for (const key of ['scan', 'scenarios', 'map', 'pack', 'gaps', 'preview', 'apply', 'rollback', 'draft', 'dispatch']) {
    assert.equal(routeOf(routes, ROUTE_PATHS[key]).method, 'POST', key + ' 必须是 POST')
  }
})

// ---------------------------------------------------------------------------
// GET state
// ---------------------------------------------------------------------------

test('GET state：返回 scan/map/proposals/selections 与 warnings；缺失文档为 null', async () => {
  const store = createFakeStore({
    scan: sampleScan(),
    map: sampleMap(),
    proposals: sampleProposals(),
    selections: { selected: ['dev'], custom: '一句话' },
  })
  const response = await call(makeDeps({ store }), ROUTE_PATHS.state, {})
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(response.json).sort(), ['dispatch', 'dispatchSupported', 'map', 'proposals', 'scan', 'selections', 'warnings'])
  assert.deepEqual(response.json.scan, sampleScan())
  assert.deepEqual(response.json.map, sampleMap())
  assert.deepEqual(response.json.proposals, sampleProposals())
  assert.deepEqual(response.json.selections, { selected: ['dev'], custom: '一句话' })
  assert.deepEqual(response.json.warnings, [])
})

test('GET state：缺失的状态文档返回 null（首次使用不是错误）', async () => {
  const response = await call(makeDeps(), ROUTE_PATHS.state, {})
  assert.equal(response.status, 200)
  assert.equal(response.json.scan, null)
  assert.equal(response.json.map, null)
  assert.equal(response.json.proposals, null)
  assert.equal(response.json.selections, null)
})

test('GET state：坏文档的 error 透传进 warnings，handler 不抛错', async () => {
  const store = createFakeStore()
  store.errors.scan = '状态 "scan" 的 JSON 已损坏：Unexpected token'
  const response = await call(makeDeps({ store }), ROUTE_PATHS.state, {})
  assert.equal(response.status, 200)
  assert.equal(response.json.scan, null)
  assert.equal(response.json.warnings.length, 1)
  assert.match(response.json.warnings[0], /scan/)
  assert.match(response.json.warnings[0], /损坏/)
})

test('GET state：store.read 自己抛错也不冒泡，每个文档一条 warning', async () => {
  const store = createFakeStore()
  store.read = async () => {
    throw new Error('disk boom')
  }
  const response = await call(makeDeps({ store }), ROUTE_PATHS.state, {})
  assert.equal(response.status, 200)
  assert.equal(response.json.scan, null)
  assert.equal(response.json.map, null)
  assert.equal(response.json.proposals, null)
  assert.equal(response.json.selections, null)
  assert.equal(response.json.warnings.length, 5)
  for (const message of response.json.warnings) assert.match(message, /disk boom/)
})

// ---------------------------------------------------------------------------
// POST scan
// ---------------------------------------------------------------------------

test('POST scan：只调用一次 scanFacts（fake host 计数）并把合法 scan 写入 store', async () => {
  const host = createFakeHost()
  const store = createFakeStore()
  const response = await call(makeDeps({ host, store }), ROUTE_PATHS.scan, {})
  assert.equal(response.status, 200, JSON.stringify(response.json))
  assert.equal(host.counts.listTools, 1, 'scan 路由必须只调用一次 scanFacts')
  assert.equal(host.counts.listPlugins, 1)
  assert.equal(host.counts.listSkills, 1)
  assert.equal(host.counts.sessionEvents, 1)
  assert.deepEqual(host.sessionEventSince, [daysBefore(30)], 'F5：scan 必须把 30 天窗口下推给 sessionEvents')
  assert.deepEqual(schemas.scan.validate(response.json), { ok: true, errors: [] })
  const written = store.writes.filter((write) => write.name === 'scan')
  assert.equal(written.length, 1, '扫描结果必须写一次 store(scan)')
  assert.deepEqual(written[0].value, response.json)
})

test('POST scan：用量来自注入的会话事件，generatedAt 使用注入的 now', async () => {
  const response = await call(makeDeps(), ROUTE_PATHS.scan, {})
  assert.equal(response.status, 200)
  assert.equal(response.json.generatedAt, NOW_ISO)
  const read = response.json.tools.find((tool) => tool.name === 'read')
  const grep = response.json.tools.find((tool) => tool.name === 'grep')
  assert.equal(read.used30d, 2)
  assert.equal(read.lastUsedAt, daysBefore(1))
  assert.equal(grep.used30d, 1)
  assert.equal(response.json.totals.unusedTools, 1, '只有 stow_scan 是已知 0 次')
})

test('POST scan（S1）：summarizeUsage 期间新增 warning → 用量强制 unknown，used30d 全 null 且原因进 warnings', async () => {
  const host = createFakeHost({
    onSessionEvent(index) {
      if (index === 1) host.pushWarning('sessionQuery.readSession(session-9) 失败：boom')
    },
  })
  const store = createFakeStore()
  const response = await call(makeDeps({ host, store }), ROUTE_PATHS.scan, {})
  assert.equal(response.status, 200)
  assert.ok(response.json.tools.length > 0)
  for (const tool of response.json.tools) assert.equal(tool.used30d, null, '部分缺失不能当成已知 0：' + tool.name)
  assert.equal(response.json.totals.unusedTools, 0, '未知用量不能计入近30天未用')
  assert.ok(response.json.warnings.some((message) => message.includes('会话用量未知')), JSON.stringify(response.json.warnings))
  assert.ok(response.json.warnings.some((message) => message.includes('session-9')), '原因必须并入 scan.warnings')
  assert.equal(store.writes.filter((write) => write.name === 'scan').length, 1)
})

test('POST scan（S1 收窄）：非会话类新增 warning 不把用量改成 unknown', async () => {
  const host = createFakeHost({
    onSessionEvent(index) {
      if (index === 1) host.pushWarning('attribution 扫描较慢：仅提示，与用量读取无关')
    },
  })
  const response = await call(makeDeps({ host }), ROUTE_PATHS.scan, {})
  assert.equal(response.status, 200)
  const read = response.json.tools.find((tool) => tool.name === 'read')
  assert.equal(read.used30d, 2, '非会话类 warning 不应否定已知用量')
  assert.ok(!response.json.warnings.some((message) => message.includes('会话用量未知')), '非会话类 warning 不触发 S1 降级')
  assert.ok(response.json.warnings.some((message) => message.includes('attribution')), '告警仍要透传')
})

test('POST scan：scan.warnings 去重且保序（宿主同一 warning 重复出现只保留一次）', async () => {
  const repeated = 'sessionQuery.readSession(session-9) 失败：boom'
  const host = createFakeHost({
    onSessionEvent(index) {
      if (index === 1) host.pushWarning(repeated)
    },
  })
  host.pushWarning(repeated)
  const response = await call(makeDeps({ host }), ROUTE_PATHS.scan, {})
  assert.equal(response.status, 200)
  assert.equal(response.json.warnings.filter((message) => message === repeated).length, 1, '重复 warning 只保留一条')
  assert.equal(new Set(response.json.warnings).size, response.json.warnings.length, 'scan.warnings 整体去重')
  assert.ok(response.json.warnings.some((message) => message.includes('会话用量未知')), '会话类 warning 仍触发 S1')
})

test('POST scan：usage 源头整体不可用时 used30d 为 null 而不是 0（D12）', async () => {
  const host = createFakeHost()
  host.sessionEvents = () => null
  const response = await call(makeDeps({ host }), ROUTE_PATHS.scan, {})
  assert.equal(response.status, 200)
  assert.equal(response.json.tools.length > 0, true)
  for (const tool of response.json.tools) assert.equal(tool.used30d, null)
  assert.equal(response.json.totals.unusedTools, 0)
})

// ---------------------------------------------------------------------------
// POST scenarios
// ---------------------------------------------------------------------------

test('POST scenarios：归一化（去重/未知 id/custom 200 字截断）后写 store 并返回保存值', async () => {
  const store = createFakeStore()
  const response = await call(makeDeps({ store }), ROUTE_PATHS.scenarios, {
    selected: ['dev', 'dev', 'nope', 'content', 7],
    custom: 'x'.repeat(300),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.selected, ['dev', 'content'])
  assert.equal(typeof response.json.custom, 'string')
  assert.equal(Array.from(response.json.custom).length, 200)
  const written = store.writes.filter((write) => write.name === 'selections')
  assert.equal(written.length, 1)
  assert.deepEqual(written[0].value, response.json)
})

test('POST scenarios：空对象保存空选择；已保存选择可被 state 读回', async () => {
  const store = createFakeStore()
  const deps = makeDeps({ store })
  const saved = await call(deps, ROUTE_PATHS.scenarios, {})
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.json, { selected: [], custom: '' })
  const state = await call(deps, ROUTE_PATHS.state, {})
  assert.deepEqual(state.json.selections, { selected: [], custom: '' })
})

test('POST scenarios：非对象 body（数组/字符串/数字）返回 400 且不写 store', async () => {
  for (const payload of [[], 'dev', 42]) {
    const store = createFakeStore()
    const response = await call(makeDeps({ store }), ROUTE_PATHS.scenarios, payload)
    assertFailure(response, 400, /请求体/)
    assert.deepEqual(store.writes, [])
  }
})

test('POST scenarios：字段类型非法返回 400', async () => {
  const selectedBad = await call(makeDeps(), ROUTE_PATHS.scenarios, { selected: 'dev' })
  assertFailure(selectedBad, 400, /selected/)
  const customBad = await call(makeDeps(), ROUTE_PATHS.scenarios, { custom: 42 })
  assertFailure(customBad, 400, /custom/)
})

// ---------------------------------------------------------------------------
// POST map
// ---------------------------------------------------------------------------

test('POST map：合法地图通过 schemas.map 校验后写 store 并返回 {ok:true}', async () => {
  const store = createFakeStore()
  const response = await call(makeDeps({ store }), ROUTE_PATHS.map, { map: sampleMap() })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { ok: true })
  const written = store.writes.filter((write) => write.name === 'map')
  assert.equal(written.length, 1)
  assert.deepEqual(written[0].value, sampleMap())
})

test('POST map：非法地图返回 400（带 errors）且不落盘', async () => {
  const store = createFakeStore()
  const response = await call(makeDeps({ store }), ROUTE_PATHS.map, { map: { stages: 'nope' } })
  assertFailure(response, 400, /地图校验失败/)
  assert.ok(Array.isArray(response.json.errors) && response.json.errors.length > 0)
  assert.deepEqual(store.writes, [])
})

test('POST map：缺少 map 字段返回 400', async () => {
  const response = await call(makeDeps(), ROUTE_PATHS.map, {})
  assertFailure(response, 400, /map/)
})

test('POST map（F7）：custom 复用 scenarios 的 200 码点截断，再校验/落盘且不改输入', async () => {
  const store = createFakeStore()
  const map = sampleMap()
  map.custom = '😀'.repeat(205)
  const response = await call(makeDeps({ store }), ROUTE_PATHS.map, { map })
  assert.equal(response.status, 200)
  const written = store.writes.filter((write) => write.name === 'map')
  assert.equal(written.length, 1)
  assert.equal(Array.from(written[0].value.custom).length, 200, '必须按码点截断到 200，不能劈开代理对')
  assert.equal(written[0].value.custom, '😀'.repeat(200))
  assert.equal(Array.from(map.custom).length, 205, '不得修改调用方传入的 map')
})

// ---------------------------------------------------------------------------
// POST pack (R-PACK): buildPack + proposals upsert, never exports a file
// ---------------------------------------------------------------------------

/** R-PACK: /pack 只写提案；packs/ 目录必须不存在（apply 才是落盘点）。 */
async function assertNoPacksExport(home) {
  await assert.rejects(stat(join(home, 'packs')), { code: 'ENOENT' }, '/pack 不得写 packs/ 文件')
}

test('POST pack：没有地图时返回 400 NO_MAP，不写提案也不导出文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-pack-'))
  cleanup.push(home)
  const store = createFakeStore()
  const response = await call(makeDeps({ store, home }), ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  assertFailure(response, 400, /地图/)
  assert.equal(response.json.code, 'NO_MAP')
  assert.deepEqual(store.writes, [], '无地图不得写 proposals')
  await assertNoPacksExport(home)
})

test('POST pack：stageIds 引用未知阶段返回 400，不写提案也不导出文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-pack-'))
  cleanup.push(home)
  const store = createFakeStore({ map: sampleMap() })
  const response = await call(makeDeps({ store, home }), ROUTE_PATHS.pack, { stageIds: ['nope'], title: '研发包' })
  assertFailure(response, 400, /不存在/)
  assert.deepEqual(store.writes, [], 'buildPack 失败不得写 proposals')
  await assertNoPacksExport(home)
})

test('POST pack：生成 kind=pack 提案写入 proposals，不写 packs 文件，返回 {pack,proposal}', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-pack-'))
  cleanup.push(home)
  const store = createFakeStore({ map: sampleMap(), proposals: sampleProposals() })
  const response = await call(makeDeps({ store, home }), ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  assert.equal(response.status, 200, JSON.stringify(response.json))
  assert.deepEqual(Object.keys(response.json).sort(), ['pack', 'proposal'], 'R-PACK：/pack 返回 {pack,proposal}，不再返回 path')
  const { pack, proposal } = response.json
  assert.deepEqual(schemas.pack.validate(pack), { ok: true, errors: [] })
  assert.equal(pack.version, 1)
  assert.deepEqual(pack.stageIds, ['understand'])
  assert.deepEqual(pack.tools, ['read'])
  assert.deepEqual(proposal, {
    id: pack.id,
    kind: 'pack',
    title: '研发包',
    effect: '导出能力包 研发包（1 个工具 / 1 个技能）',
    evidence: { source: 'map', refs: ['understand'] },
  })
  const writes = store.writes.filter((write) => write.name === 'proposals')
  assert.equal(writes.length, 1, '生成提案必须写一次 proposals')
  const written = writes[0].value
  assert.deepEqual(schemas.proposals.validate(written), { ok: true, errors: [] })
  assert.deepEqual(written.items.map((item) => item.id), ['pack-dev', 'install-web', pack.id], '既有提案保留、新提案追加')
  assert.deepEqual(written.items[2], proposal)
  assert.equal(written.generatedAt, NOW_ISO, 'generatedAt 使用注入时钟')
  const packWrites = store.writes.filter((write) => write.name === 'packs')
  assert.equal(packWrites.length, 1, 'F2/R-8A：/pack 必须把生成时的 pack 写入 store(packs)')
  assert.deepEqual(schemas.packs.validate(packWrites[0].value), { ok: true, errors: [] })
  assert.deepEqual(packWrites[0].value, { packs: [pack] })
  assert.deepEqual(store.writes.map((write) => write.name).slice(-2), ['packs', 'proposals'], '先存 pack 再写提案')
  await assertNoPacksExport(home)
})

test('POST pack：同参数重复调用幂等——同 id 提案原地替换、不重复追加', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-pack-'))
  cleanup.push(home)
  const store = createFakeStore({ map: sampleMap(), proposals: sampleProposals() })
  const deps = makeDeps({ store, home })
  const first = await call(deps, ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  const second = await call(deps, ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.json.pack.id, first.json.pack.id, 'pack id 必须确定性，重复调用命中同一条提案')
  const writes = store.writes.filter((write) => write.name === 'proposals')
  assert.equal(writes.length, 2)
  const finalDoc = writes[1].value
  assert.deepEqual(finalDoc.items.map((item) => item.id), ['pack-dev', 'install-web', first.json.pack.id], '同 id 原地替换，不追加第二条')
  assert.deepEqual(second.json.proposal, first.json.proposal)
  assert.equal(finalDoc.items.filter((item) => item.kind === 'pack' && item.id === first.json.pack.id).length, 1)
  await assertNoPacksExport(home)
})

test('POST pack：既有 proposals 文档损坏/不可读时 400 PROPOSALS_INVALID，不覆盖原文档', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-pack-'))
  cleanup.push(home)
  const brokenShape = createFakeStore({ map: sampleMap(), proposals: { items: 'nope', generatedAt: NOW_ISO } })
  const shapeResponse = await call(makeDeps({ store: brokenShape, home }), ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  assertFailure(shapeResponse, 400, /提案/)
  assert.equal(shapeResponse.json.code, 'PROPOSALS_INVALID')
  assert.deepEqual(brokenShape.writes, [], '坏文档不得被覆盖')
  const unreadable = createFakeStore({ map: sampleMap() })
  unreadable.errors.proposals = '状态 "proposals" 的 JSON 已损坏：Unexpected token'
  const readResponse = await call(makeDeps({ store: unreadable, home }), ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  assertFailure(readResponse, 400, /提案/)
  assert.equal(readResponse.json.code, 'PROPOSALS_INVALID')
  assert.deepEqual(unreadable.writes, [])
  await assertNoPacksExport(home)
})

test('registerTools：stow_pack_build 与 /pack 路由同行为（写提案、不写 packs 文件）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-pack-'))
  cleanup.push(home)
  const store = createFakeStore({ map: sampleMap() })
  const tools = registerTools({ deps: makeDeps({ store, home }) })
  const result = await tools.find((tool) => tool.name === 'stow_pack_build').handler({ stageIds: ['understand'], title: '研发包' })
  assert.equal(result.pack.id, result.proposal.id)
  assert.equal(result.proposal.kind, 'pack')
  assert.deepEqual(result.proposal.evidence, { source: 'map', refs: ['understand'] })
  const writes = store.writes.filter((write) => write.name === 'proposals')
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].value.items, [result.proposal])
  const packWrites = store.writes.filter((write) => write.name === 'packs')
  assert.equal(packWrites.length, 1, 'stow_pack_build 与 /pack 同行为：也存 pack')
  assert.equal(packWrites[0].value.packs[0].id, result.pack.id)
  await assertNoPacksExport(home)
})

test('POST pack（F2）：同 id 重复生成在 store(packs) 里原地替换、不追加', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-pack-'))
  cleanup.push(home)
  const store = createFakeStore({ map: sampleMap() })
  const deps = makeDeps({ store, home })
  const first = await call(deps, ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  const second = await call(deps, ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(first.json.pack.id, second.json.pack.id)
  const stored = (await store.read('packs')).value
  assert.deepEqual(stored.packs.map((pack) => pack.id), [second.json.pack.id], '同 id 原地替换，不重复追加')
  assert.deepEqual(stored.packs[0], second.json.pack)
  await assert.rejects(stat(join(home, 'packs')), { code: 'ENOENT' })
})

test('POST pack（F2）：store(packs) 上限 50 条，超出丢弃最旧并返回 warning', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-pack-'))
  cleanup.push(home)
  const map = sampleMap()
  const seeded = Array.from({ length: 50 }, (_, index) => buildPack({ map, stageIds: ['understand'], title: '旧包 ' + index }))
  const store = createFakeStore({ map, packs: { packs: seeded } })
  const response = await call(makeDeps({ store, home }), ROUTE_PATHS.pack, { stageIds: ['deliver'], title: '新包' })
  assert.equal(response.status, 200, JSON.stringify(response.json))
  assert.ok(Array.isArray(response.json.warnings) && response.json.warnings.length === 1, JSON.stringify(response.json.warnings))
  assert.match(response.json.warnings[0], /上限|丢弃/)
  const stored = (await store.read('packs')).value
  assert.equal(stored.packs.length, 50, '上限 50 条')
  assert.equal(stored.packs.some((pack) => pack.id === seeded[0].id), false, '丢弃最旧')
  assert.equal(stored.packs[stored.packs.length - 1].id, response.json.pack.id, '新包追加在尾部')
})

test('POST pack（F2）：packs 状态损坏/不可读时 400 PACKS_INVALID，不覆盖也不写提案', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-pack-'))
  cleanup.push(home)
  const broken = createFakeStore({ map: sampleMap(), packs: { packs: 'nope' } })
  const shapeResponse = await call(makeDeps({ store: broken, home }), ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  assertFailure(shapeResponse, 400, /能力包/)
  assert.equal(shapeResponse.json.code, 'PACKS_INVALID')
  assert.deepEqual(broken.writes, [], '坏文档不得被覆盖')
  const unreadable = createFakeStore({ map: sampleMap() })
  unreadable.errors.packs = '状态 "packs" 的 JSON 已损坏：Unexpected token'
  const readResponse = await call(makeDeps({ store: unreadable, home }), ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  assertFailure(readResponse, 400, /能力包/)
  assert.equal(readResponse.json.code, 'PACKS_INVALID')
  assert.deepEqual(unreadable.writes, [])
  await assert.rejects(stat(join(home, 'packs')), { code: 'ENOENT' })
})

// ---------------------------------------------------------------------------
// POST gaps
// ---------------------------------------------------------------------------

test('POST gaps：目录可用时生成缺口提案，落盘 proposals（schema 合法）并返回 {items,error}', async () => {
  const store = createFakeStore({ scan: sampleScan(), map: sampleMap() })
  const catalog = async () => ({ entries: [{ name: 'dsh-websearch', title: '联网搜索', description: 'web_search 工具' }], stale: false, error: null })
  const response = await call(makeDeps({ store, catalog }), ROUTE_PATHS.gaps, {})
  assert.equal(response.status, 200, JSON.stringify(response.json))
  assert.ok(Array.isArray(response.json.items) && response.json.items.length > 0)
  assert.equal(response.json.error, null)
  assert.equal(response.json.items[0].kind, 'install')
  assert.match(response.json.items[0].id, /^gap-/)
  const written = store.writes.filter((write) => write.name === 'proposals')
  assert.equal(written.length, 1)
  assert.deepEqual(schemas.proposals.validate(written[0].value), { ok: true, errors: [] })
  assert.deepEqual(written[0].value.items, response.json.items)
  assert.equal(typeof written[0].value.generatedAt, 'string')
})

test('POST gaps：目录加载失败 fail-open（items [] + error 字符串），仍写 proposals 且不抛', async () => {
  const store = createFakeStore({ scan: sampleScan(), map: sampleMap() })
  const catalog = async () => ({ entries: [], stale: false, error: '目录加载失败：源不可达' })
  const response = await call(makeDeps({ store, catalog }), ROUTE_PATHS.gaps, {})
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.items, [])
  assert.match(response.json.error, /源不可达/)
  const written = store.writes.filter((write) => write.name === 'proposals')
  assert.equal(written.length, 1)
  assert.deepEqual(written[0].value.items, [])
})

test('POST gaps：没有地图返回 400 NO_MAP 且不写 proposals（D7 追加语义）', async () => {
  const store = createFakeStore({ scan: sampleScan() })
  const response = await call(
    makeDeps({ store, catalog: async () => ({ entries: [], stale: false, error: null }) }),
    ROUTE_PATHS.gaps,
    {},
  )
  assertFailure(response, 400, /地图/)
  assert.equal(response.json.code, 'NO_MAP')
  assert.deepEqual(store.writes, [])
})

// ---------------------------------------------------------------------------
// POST preview / apply / rollback
// ---------------------------------------------------------------------------

test('POST preview：未给 ids 时预览全部提案并返回稳定 hash', async () => {
  const store = createFakeStore({ proposals: sampleProposals() })
  const response = await call(makeDeps({ store }), ROUTE_PATHS.preview, {})
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.items.map((item) => item.id), ['pack-dev', 'install-web'])
  assert.match(response.json.hash, /^[0-9a-f]{64}$/)
  const again = await call(makeDeps({ store }), ROUTE_PATHS.preview, {})
  assert.equal(again.json.hash, response.json.hash)
})

test('POST preview：未知提案 id 返回 400（code UNKNOWN_PROPOSAL）', async () => {
  const store = createFakeStore({ proposals: sampleProposals() })
  const response = await call(makeDeps({ store }), ROUTE_PATHS.preview, { ids: ['nope'] })
  assertFailure(response, 400, /未知的提案 id/)
  assert.equal(response.json.code, 'UNKNOWN_PROPOSAL')
})

test('POST preview：ids 类型非法返回 400（code IDS_INVALID）', async () => {
  const store = createFakeStore({ proposals: sampleProposals() })
  const response = await call(makeDeps({ store }), ROUTE_PATHS.preview, { ids: 'pack-dev' })
  assertFailure(response, 400, /ids/)
  assert.equal(response.json.code, 'IDS_INVALID')
})

test('POST preview：没有提案数据返回 400（NO_PROPOSALS）', async () => {
  const response = await call(makeDeps(), ROUTE_PATHS.preview, {})
  assertFailure(response, 400, /提案/)
  assert.equal(response.json.code, 'NO_PROPOSALS')
})

test('POST apply：缺少 ids / 空 ids / 未知 id 都是 400', async () => {
  const store = createFakeStore({ proposals: sampleProposals() })
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-apply-'))
  cleanup.push(home)
  const deps = makeDeps({ store, home })
  assertFailure(await call(deps, ROUTE_PATHS.apply, {}), 400, /ids/)
  assertFailure(await call(deps, ROUTE_PATHS.apply, { ids: [] }), 400, /没有选中/)
  const unknown = await call(deps, ROUTE_PATHS.apply, { ids: ['nope'] })
  assertFailure(unknown, 400, /未知的提案 id/)
  assert.equal(unknown.json.code, 'UNKNOWN_PROPOSAL')
})

test('POST apply：状态读取 I/O 失败映射为 500（STATE_READ_FAILED）', async () => {
  const store = createFakeStore({ proposals: sampleProposals() })
  store.read = async () => {
    throw new Error('disk boom')
  }
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-apply-'))
  cleanup.push(home)
  const response = await call(makeDeps({ store, home }), ROUTE_PATHS.apply, { ids: ['install-web'] })
  assertFailure(response, 500, /disk boom/)
  assert.equal(response.json.code, 'STATE_READ_FAILED')
})

test('POST apply（F2）：提案 id 在 store(packs) 缺失 → 400 PACK_NOT_FOUND，不建快照', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-apply-'))
  cleanup.push(home)
  const store = createFakeStore({ proposals: sampleProposals() })
  const response = await call(makeDeps({ store, home }), ROUTE_PATHS.apply, { ids: ['pack-dev'] })
  assertFailure(response, 400, /能力包/)
  assert.equal(response.json.code, 'PACK_NOT_FOUND')
  assert.deepEqual(store.writes, [])
  assert.deepEqual(store.snapshots, [])
})

test('POST rollback：非法 snapshotId 映射为 404（ROLLBACK_FAILED）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-rollback-'))
  cleanup.push(home)
  for (const snapshotId of ['', '../etc', 'bad id!', 42]) {
    const response = await call(makeDeps({ home }), ROUTE_PATHS.rollback, { snapshotId })
    assertFailure(response, 404, /快照/)
    assert.equal(response.json.code, 'ROLLBACK_FAILED')
  }
})

test('POST rollback：快照不存在映射为 404（ROLLBACK_FAILED），不抛给 HTTP 层', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-rollback-'))
  cleanup.push(home)
  const store = createFakeStore()
  const response = await call(makeDeps({ store, home }), ROUTE_PATHS.rollback, { snapshotId: 'snapshot-missing' })
  assertFailure(response, 404, /快照/)
  assert.equal(response.json.code, 'ROLLBACK_FAILED')
})

test('POST rollback（F7）：快照存在但 store.restore I/O 失败 → 500（ROLLBACK_RESTORE_FAILED），不再误报 404', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-rollback-'))
  cleanup.push(home)
  await mkdir(join(home, 'snapshots', 'snap-001'), { recursive: true })
  await writeFile(
    join(home, 'snapshots', 'snap-001', 'meta.json'),
    JSON.stringify({ id: 'snap-001', tag: 'before-apply', createdAt: NOW_ISO, files: [] }),
  )
  const store = createFakeStore()
  store.restore = async () => {
    throw new Error('disk boom on restore')
  }
  const response = await call(makeDeps({ store, home }), ROUTE_PATHS.rollback, { snapshotId: 'snap-001' })
  assertFailure(response, 500, /回滚失败|disk boom/)
  assert.equal(response.json.code, 'ROLLBACK_RESTORE_FAILED')
})

// ---------------------------------------------------------------------------
// POST draft
// ---------------------------------------------------------------------------

test('POST draft：dispatch 基于最近扫描生成非空派单草稿，并说明不会代发/塞输入框', async () => {
  const store = createFakeStore({ scan: sampleScan() })
  const response = await call(makeDeps({ store }), ROUTE_PATHS.draft, { kind: 'dispatch' })
  assert.equal(response.status, 200)
  assert.equal(typeof response.json.text, 'string')
  assert.ok(response.json.text.length > 10)
  assert.match(response.json.text, /这个活只需要/)
  assert.match(response.json.text, /read/)
  for (const phrase of ['不会把它塞进输入框', '不会代发']) {
    assert.ok(response.json.text.includes(phrase), 'D14 文案缺失：' + phrase + '\n' + response.json.text)
  }
})

test('POST draft：没有扫描结果也返回可粘贴的非空文本', async () => {
  const response = await call(makeDeps(), ROUTE_PATHS.draft, { kind: 'dispatch' })
  assert.equal(response.status, 200)
  assert.ok(response.json.text.length > 10)
  assert.match(response.json.text, /扫描/)
})

test('POST draft：未知 kind 与非法 body 返回 400', async () => {
  assertFailure(await call(makeDeps(), ROUTE_PATHS.draft, { kind: 'chat' }), 400, /dispatch/)
  assertFailure(await call(makeDeps(), ROUTE_PATHS.draft, {}), 400, /dispatch/)
  assertFailure(await call(makeDeps(), ROUTE_PATHS.draft, []), 400, /请求体/)
})

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

const EXPECTED_TOOL_NAMES = [
  'stow_scan',
  'stow_status',
  'stow_map_save',
  'stow_pack_build',
  'stow_gaps',
  'stow_preview',
  'stow_apply',
  'stow_rollback',
  'stow_draft',
]

test('registerTools：返回 9 个 stow_* 工具，名字逐字一致且 handler 是函数', () => {
  const tools = registerTools({ deps: makeDeps() })
  assert.equal(tools.length, 9)
  assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOL_NAMES.slice().sort())
  for (const tool of tools) assert.equal(typeof tool.handler, 'function', tool.name)
})

test('registerTools：stow_status 汇总工具/插件/技能数与未知用量标记、最近扫描时间', async () => {
  const store = createFakeStore({ scan: sampleScan(), map: sampleMap(), proposals: sampleProposals() })
  const tools = registerTools({ deps: makeDeps({ store }) })
  const status = await tools.find((tool) => tool.name === 'stow_status').handler({})
  assert.equal(status.plugins, 1)
  assert.equal(status.tools, 2)
  assert.equal(status.skills, 1)
  assert.equal(status.unusedTools, 1)
  assert.equal(status.usageUnknown, false)
  assert.equal(status.lastScanAt, NOW_ISO)
  assert.equal(status.hasMap, true)
  assert.equal(status.proposals, 2)
  assert.deepEqual(status.warnings, [])
})

test('registerTools：stow_status 在用量未知时标记 usageUnknown=true', async () => {
  const scan = sampleScan()
  for (const tool of scan.tools) {
    tool.used30d = null
    tool.lastUsedAt = null
  }
  scan.totals.unusedTools = 0
  const tools = registerTools({ deps: makeDeps({ store: createFakeStore({ scan }) }) })
  const status = await tools.find((tool) => tool.name === 'stow_status').handler({})
  assert.equal(status.usageUnknown, true)
})

test('registerTools：stow_scan 复用同一扫描逻辑，返回 scan 并写 store', async () => {
  const host = createFakeHost()
  const store = createFakeStore()
  const tools = registerTools({ deps: makeDeps({ host, store }) })
  const scan = await tools.find((tool) => tool.name === 'stow_scan').handler({})
  assert.deepEqual(schemas.scan.validate(scan), { ok: true, errors: [] })
  assert.equal(scan.generatedAt, NOW_ISO)
  assert.equal(host.counts.listTools, 1)
  assert.equal(store.writes.filter((write) => write.name === 'scan').length, 1)
})

test('registerTools：stow_map_save / stow_gaps / stow_preview 与路由同一批函数', async () => {
  const store = createFakeStore({ proposals: sampleProposals() })
  const deps = makeDeps({ store, catalog: async () => ({ entries: [], stale: false, error: null }) })
  const tools = registerTools({ deps })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const saved = await byName.get('stow_map_save').handler({ map: sampleMap() })
  assert.deepEqual(saved, { ok: true })
  assert.equal(store.writes.filter((write) => write.name === 'map').length, 1)
  const preview = await byName.get('stow_preview').handler({})
  assert.equal(preview.items.length, 2)
  const gaps = await byName.get('stow_gaps').handler({})
  assert.ok(Array.isArray(gaps.items))
  assert.equal(store.writes.filter((write) => write.name === 'proposals').length, 1)
})

test('registerTools：工具失败时抛出带 status 的错误（stow_apply 缺 ids → 400）', async () => {
  const store = createFakeStore({ proposals: sampleProposals() })
  const home = await mkdtemp(join(tmpdir(), 'guizhi-routes-tool-'))
  cleanup.push(home)
  const tools = registerTools({ deps: makeDeps({ store, home }) })
  const stowApply = tools.find((tool) => tool.name === 'stow_apply')
  await assert.rejects(stowApply.handler({}), (error) => {
    assert.equal(error.status, 400)
    assert.match(error.message, /ids/)
    assert.equal(error.payload.code, 'IDS_INVALID')
    return true
  })
})

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

test('写盘 I/O 失败时 handler 返回 500 + 可读 error，不把异常漏给 HTTP 层', async () => {
  const store = createFakeStore()
  store.write = async () => {
    throw new Error('disk full')
  }
  const response = await call(makeDeps({ store }), ROUTE_PATHS.scenarios, { selected: ['dev'] })
  assertFailure(response, 500, /disk full/)
  assert.equal(response.json.code, 'STATE_WRITE_FAILED')
})

// ---------------------------------------------------------------------------
// Host defineTool DSL static regression (fix round 1, R-7A Critical 3)
// ---------------------------------------------------------------------------

/** Value-schema types the host defineTool DSL accepts (dsh-tools 0.2.2-rc.5). */
const HOST_DSL_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'])

/** @param {unknown} value */
function isSchemaObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Walk one author value schema the same way the host compiler does and collect
 * violations of the enforced DSL subset (dsh-tools schema.js, rc.5):
 * - a property-level required must be exactly true (false is refused);
 * - type object must declare an explicit boolean additionalProperties;
 * - type must be one of the host types (or oneOf the alternative form);
 * - required may only appear at property level.
 * @param {unknown} value @param {string} path @param {string[]} violations @param {{ property?: boolean }} [context]
 */
function collectDslViolations(value, path, violations, context = {}) {
  if (!isSchemaObject(value)) {
    violations.push(path + ': 必须是值 schema 对象')
    return
  }
  if (Object.hasOwn(value, 'required') && context.property !== true) {
    violations.push(path + '.required: 只能出现在参数属性级')
  }
  if (context.property === true && Object.hasOwn(value, 'required') && value.required !== true) {
    violations.push(path + '.required: 宿主 DSL 只允许 true，可选参数必须省略 required')
  }
  if (Object.hasOwn(value, 'type')) {
    if (!HOST_DSL_TYPES.has(value.type)) {
      violations.push(path + '.type: 宿主 DSL 不支持 ' + JSON.stringify(value.type))
    }
    if (value.type === 'object' && typeof value.additionalProperties !== 'boolean') {
      violations.push(path + '.additionalProperties: type=object 必须显式 true/false')
    }
  } else if (!Object.hasOwn(value, 'oneOf')) {
    violations.push(path + ': 必须声明 type 或 oneOf')
  }
  if (Object.hasOwn(value, 'oneOf')) {
    if (!Array.isArray(value.oneOf) || value.oneOf.length < 2) {
      violations.push(path + '.oneOf: 必须是至少两个分支的数组')
    } else {
      value.oneOf.forEach((branch, index) => collectDslViolations(branch, path + '.oneOf[' + index + ']', violations))
    }
  }
  if (isSchemaObject(value.properties)) {
    for (const [key, property] of Object.entries(value.properties)) {
      collectDslViolations(property, path + '.properties.' + key, violations, { property: true })
    }
  }
  if (Object.hasOwn(value, 'items')) {
    collectDslViolations(value.items, path + '.items', violations)
  }
}

test('TOOL_SPECS 参数符合宿主 defineTool DSL：required 仅 true、object 显式 additionalProperties、type 白名单', () => {
  assert.ok(Array.isArray(TOOL_SPECS), 'TOOL_SPECS 必须导出为数组供接线与回归测试使用')
  assert.equal(TOOL_SPECS.length, 9)
  const violations = []
  for (const spec of TOOL_SPECS) {
    const parameters = spec.parameters
    if (!isSchemaObject(parameters)) {
      violations.push(spec.name + '.parameters: 必须是对象')
      continue
    }
    for (const [name, schema] of Object.entries(parameters)) {
      collectDslViolations(schema, spec.name + '.parameters.' + name, violations, { property: true })
    }
  }
  assert.deepEqual(violations, [], '宿主 DSL 违规：' + violations.join('；'))
})

test('TOOL_SPECS 回归：stow_preview.ids 省略 required（可选）、stow_map_save.map 用 json 类型', () => {
  const byName = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]))
  const previewIds = byName.get('stow_preview').parameters.ids
  assert.equal(Object.hasOwn(previewIds, 'required'), false, '可选参数必须省略 required（宿主 DSL 拒绝 required:false）')
  assert.equal(previewIds.type, 'array')
  const mapParam = byName.get('stow_map_save').parameters.map
  assert.equal(mapParam.type, 'json', 'map 是任意 JSON 文档，用宿主 DSL 的 json 类型；结构由 schemas.map 兜底')
  assert.equal(mapParam.required, true)
  assert.equal(typeof mapParam.description, 'string')
  assert.ok(mapParam.description.length > 0)
})

test('TOOL_SPECS 仍能经 registerTools 注册出 9 个工具（DSL 修复不改变工具面）', () => {
  const tools = registerTools({ deps: makeDeps() })
  assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOL_NAMES.slice().sort())
})

// ---------------------------------------------------------------------------
// POST dispatch
// ---------------------------------------------------------------------------

test('POST dispatch：kind 缺失或场景为空 → 400，且不建会话、不投递', async () => {
  const store = createFakeStore({ scan: sampleScan(), selections: { selected: [], custom: '' } })
  const deps = makeDeps({ store })
  assertFailure(await call(deps, ROUTE_PATHS.dispatch, {}), 400, /kind/)
  assertFailure(await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' }), 400, /场景/)
  assert.equal(deps.host.dispatchCalls.length, 0)
})

test('POST dispatch：宿主不支持时 → 503 + 可读原因', async () => {
  const store = createFakeStore({ scan: sampleScan(), selections: { selected: ['dev'], custom: '' } })
  const deps = makeDeps({ store, hostOptions: { dispatchSupport: { available: false, reason: '宿主缺少 sessionController' } } })
  assertFailure(await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' }), 503, /sessionController/)
})

test('POST dispatch：成功创建专用会话并投递 stow_map_save prompt，写入 running 记录', async () => {
  const store = createFakeStore({ scan: sampleScan(), selections: { selected: ['dev'], custom: '' } })
  const deps = makeDeps({ store })
  const response = await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.dispatch.state, 'running')
  assert.equal(response.json.dispatch.sessionId, 'background-session')
  assert.equal(deps.host.dispatchCalls.length, 1)
  assert.equal(deps.host.dispatchCalls[0].sessionId, 'background-session')
  assert.match(deps.host.dispatchCalls[0].text, /stow_map_save/)
  assert.match(deps.host.dispatchCalls[0].text, /研发/)
  const written = store.writes.find((write) => write.name === 'dispatch')
  assert.equal(written.value.state, 'running')
  assert.equal(written.value.sessionId, 'background-session')
})

test('POST dispatch：已有 running 记录 → 409，且不重复投递', async () => {
  const store = createFakeStore({
    scan: sampleScan(),
    selections: { selected: ['dev'], custom: '' },
    dispatch: { kind: 'map', sessionId: 's-prev', requestId: 'r-prev', startedAt: NOW_ISO, state: 'running' },
  })
  const deps = makeDeps({ store })
  assertFailure(await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' }), 409, /执行中/)
  assert.equal(deps.host.dispatchCalls.length, 0)
})

test('POST dispatch：投递失败 → 502 且记录 failed 供重试', async () => {
  const store = createFakeStore({ scan: sampleScan(), selections: { selected: ['dev'], custom: '' } })
  const deps = makeDeps({ store, hostOptions: { promptDispatchError: 'agent busy' } })
  assertFailure(await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' }), 502, /agent busy/)
  const written = store.writes.filter((write) => write.name === 'dispatch')
  assert.equal(written.length, 1)
  assert.equal(written[0].value.state, 'failed')
  assert.match(written[0].value.error, /agent busy/)
})

test('GET state：dispatch 状态由会话事件推导（running → done），读会话失败降级 unknown 且仍 200', async () => {
  const record = { kind: 'map', sessionId: 's1', requestId: 'r1', startedAt: NOW_ISO, state: 'running' }
  const runningStore = createFakeStore({ dispatch: record })
  const running = await call(makeDeps({ store: runningStore }), ROUTE_PATHS.state, {})
  assert.equal(running.status, 200)
  assert.equal(running.json.dispatch.state, 'running')
  const doneEvents = [
    { seq: 1, time: NOW.getTime() + 1000, type: 'user/message', data: { source: { rpcId: 'r1' } } },
    { seq: 2, time: NOW.getTime() + 2000, type: 'turn/end', data: {} },
  ]
  const done = await call(makeDeps({ store: createFakeStore({ dispatch: record }), hostOptions: { dispatchEvents: doneEvents } }), ROUTE_PATHS.state, {})
  assert.equal(done.json.dispatch.state, 'done')
  const unreadable = await call(makeDeps({ store: createFakeStore({ dispatch: record }), hostOptions: { dispatchReadError: 'boom' } }), ROUTE_PATHS.state, {})
  assert.equal(unreadable.status, 200)
  assert.equal(unreadable.json.dispatch.state, 'unknown')
  assert.match(unreadable.json.dispatch.error, /boom/)
})

test('POST dispatch：并发两次只允许一次准入（single-flight）', async () => {
  const store = createFakeStore({ scan: sampleScan(), selections: { selected: ['dev'], custom: '' } })
  const deps = makeDeps({ store })
  const [a, b] = await Promise.all([
    call(deps, ROUTE_PATHS.dispatch, { kind: 'map' }),
    call(deps, ROUTE_PATHS.dispatch, { kind: 'map' }),
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  assert.equal(deps.host.dispatchState.sessionsCreated, 1)
  assert.equal(deps.host.dispatchState.prompts, 1)
})

test('POST dispatch：上一单 running 但会话读取失败 → 409，不建新会话', async () => {
  const store = createFakeStore({
    scan: sampleScan(),
    selections: { selected: ['dev'], custom: '' },
    dispatch: { kind: 'map', sessionId: 's-prev', requestId: 'r-prev', startedAt: NOW_ISO, state: 'running' },
  })
  const deps = makeDeps({ store, hostOptions: { dispatchReadStatus: 'unreadable', dispatchReadError: 'io boom' } })
  assertFailure(await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' }), 409, /读不到/)
  assert.equal(deps.host.dispatchState.sessionsCreated, 0)
})

test('POST dispatch：failed 记录 + 会话已删 → 重建会话并重新投递', async () => {
  const store = createFakeStore({
    scan: sampleScan(),
    selections: { selected: ['dev'], custom: '' },
    dispatch: { kind: 'map', sessionId: 's-dead', requestId: 'r-dead', startedAt: NOW_ISO, state: 'failed', error: 'model unavailable' },
  })
  const deps = makeDeps({ store, hostOptions: { dispatchReadStatus: 'missing' } })
  const response = await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' })
  assert.equal(response.status, 200)
  assert.equal(deps.host.dispatchState.sessionsCreated, 1)
  assert.equal(deps.host.dispatchState.prompts, 1)
  assert.equal(store.docs.get('dispatch').state, 'running')
  assert.equal(store.docs.get('dispatch').sessionId, 'background-session')
})

test('POST dispatch：复用会话投递时报会话缺失 → 重建一次并成功', async () => {
  const store = createFakeStore({
    scan: sampleScan(),
    selections: { selected: ['dev'], custom: '' },
    dispatch: { kind: 'map', sessionId: 's-live', requestId: 'r-old', startedAt: NOW_ISO, state: 'failed', error: 'boom' },
  })
  const deps = makeDeps({ store, hostOptions: { promptDispatchMissingOnce: true } })
  const response = await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' })
  assert.equal(response.status, 200)
  assert.equal(deps.host.dispatchState.sessionsCreated, 1)
  assert.equal(deps.host.dispatchState.prompts, 2)
})

test('POST dispatch：创建会话失败 → 502 且写入无 sessionId 的 failed 记录', async () => {
  const store = createFakeStore({ scan: sampleScan(), selections: { selected: ['dev'], custom: '' } })
  const deps = makeDeps({ store, hostOptions: { createDispatchError: 'no workspace' } })
  assertFailure(await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' }), 502, /no workspace/)
  const written = store.docs.get('dispatch')
  assert.equal(written.state, 'failed')
  assert.equal(written.sessionId, '')
})

test('POST dispatch：只有自定义场景也可以派单', async () => {
  const store = createFakeStore({ scan: sampleScan(), selections: { selected: [], custom: '我自己的写作流' } })
  const deps = makeDeps({ store })
  const response = await call(deps, ROUTE_PATHS.dispatch, { kind: 'map' })
  assert.equal(response.status, 200)
  assert.match(deps.host.dispatchCalls[0].text, /我自己的写作流/)
})

test('GET state：不支持派单的宿主也返回 200 + dispatchSupported=false', async () => {
  const store = createFakeStore({ dispatch: { kind: 'map', sessionId: 's1', requestId: 'r1', startedAt: NOW_ISO, state: 'running' } })
  const response = await call(
    makeDeps({ store, hostOptions: { dispatchSupport: { available: false, reason: 'no sessionController' } } }),
    ROUTE_PATHS.state,
    {},
  )
  assert.equal(response.status, 200)
  assert.equal(response.json.dispatchSupported, false)
  assert.equal(response.json.dispatch.state, 'unknown')
})

