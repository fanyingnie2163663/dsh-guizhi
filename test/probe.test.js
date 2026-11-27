import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHostAdapter,
  detectDshVersion,
  detectProfileName,
  resolveDataRoot,
  resolveDshHome,
  resolveProfilePath,
} from '../lib/host.js'
import { probeHost } from '../lib/probe.js'

/** Temp roots removed after the suite. */
const cleanup = []
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
})

/**
 * A profile fixture: package.json dependencies (one installed, one not yet) and
 * a cordis.patch.yml carrying an insert row and a plain row.
 * @returns {Promise<string>} fixture directory
 */
async function makeProfileFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'guizhi-profile-'))
  cleanup.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dependencies: {
      'dsh-ops': '0.5.5',
      '@linxin666/dsh-client-ui-skill-explorer': '0.4.19',
    },
    dsh: { profile: { bundles: ['dsh-ops'] } },
  }, null, 2))
  await mkdir(join(dir, 'node_modules', 'dsh-ops'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'dsh-ops', 'package.json'), JSON.stringify({ name: 'dsh-ops', version: '0.5.6' }))
  await writeFile(join(dir, 'cordis.patch.yml'), [
    '# profile patch fixture',
    '- insert:',
    '    - id: better-sidebar',
    "      name: 'dsh-better-sidebar'",
    '- id: ui-theme',
    '  name: "@deepseek-ai/dsh-client-ui-theme"',
    '',
  ].join('\n'))
  return dir
}

/**
 * A profile fixture whose cordis.patch.yml is unparseable while package.json
 * stays readable: npm rows must survive the patch parse failure.
 * @returns {Promise<string>} fixture directory
 */
async function makeBrokenPatchFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'guizhi-bad-patch-'))
  cleanup.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-broken-patch',
    private: true,
    dependencies: { 'dsh-ops': '0.5.5' },
  }, null, 2))
  await writeFile(join(dir, 'cordis.patch.yml'), '- insert: [unclosed\n')
  return dir
}

/**
 * Fake host context: only the services a test declares are visible.
 * @param {Record<string, unknown>} services
 * @param {string[]} [warnings]
 */
function fakeCtx(services = {}, warnings = []) {
  return {
    logger: {
      info() {},
      warn(message) { warnings.push(String(message)) },
    },
    get(name) { return Object.hasOwn(services, name) ? services[name] : undefined },
  }
}

/**
 * Adapter options that skip the real disk skill roots: these probe tests pin
 * host-only counts. The disk merge itself is covered by test/skillscan.test.js.
 */
const NO_DISK_SKILL_ROOTS = { skillRoots: [] }

/** A tools service whose global view contains two definitions. */
function fakeTools() {
  return {
    view(scope) {
      assert.equal(scope, undefined)
      return {
        visible: new Map([
          ['stow_probe', { name: 'stow_probe', description: '探测宿主能力' }],
          ['read', { name: 'read', description: 'Read a UTF-8 text file' }],
        ]),
        registrations: new Map(),
        knownNames: new Set(['stow_probe', 'read']),
        restrictableNames: new Set(['read']),
      }
    },
  }
}

/** A skills service returning two summaries, one with provider only. */
function fakeSkills() {
  return {
    async list() {
      return [
        { name: 'brainstorming', description: 'before creative work', source: 'user', provider: 'filesystem' },
        { name: 'writing-plans', description: 'write a plan', source: 'bundled', provider: 'filesystem' },
      ]
    },
  }
}

/**
 * A sessionQuery service with two sessions; every tool/call carries a distinct
 * tool name and timestamp so mapping and since-filtering are observable.
 */
function fakeSessionQuery() {
  const logs = {
    s1: [
      { type: 'tool/call', time: Date.UTC(2026, 0, 2, 3, 4, 5), data: { turn: 1, step: 1, callId: 'c1', name: 'run_code', arguments: '{}' } },
      { type: 'user/message', time: Date.UTC(2026, 0, 2, 3, 4, 6), data: { content: [] } },
      { type: 'tool/call', time: Date.UTC(2026, 0, 3, 0, 0, 0), data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{}' } },
    ],
    s2: [
      { type: 'tool/call', time: Date.UTC(2025, 11, 31, 23, 0, 0), data: { turn: 1, step: 1, callId: 'c3', name: 'write', arguments: '{}' } },
      { type: 'tool/result', time: Date.UTC(2025, 11, 31, 23, 0, 1), data: { message: {} } },
    ],
  }
  return {
    async listSessions() {
      return [
        { header: { id: 's1' }, live: true, persisted: true },
        { header: { id: 's2' }, live: true, persisted: false },
      ]
    },
    async readSession(sessionId) {
      assert.ok(Object.hasOwn(logs, sessionId))
      return { session: { id: sessionId }, inheritedEventCount: 0, events: logs[sessionId] }
    },
  }
}

/** Collect an AsyncIterable of session events. */
async function collect(iterable) {
  const rows = []
  for await (const row of iterable) rows.push(row)
  return rows
}

test('listTools 只给 name/description（owner 留给静态归因）', async () => {
  const adapter = createHostAdapter(fakeCtx({ tools: fakeTools() }))
  const tools = await adapter.listTools()
  assert.deepEqual(tools, [
    { name: 'read', description: 'Read a UTF-8 text file' },
    { name: 'stow_probe', description: '探测宿主能力' },
  ])
  for (const tool of tools) assert.equal(Object.hasOwn(tool, 'owner'), false)
})

test('listPlugins 合并 profile package.json 依赖与 cordis.patch.yml 行', async () => {
  const dir = await makeProfileFixture()
  const adapter = createHostAdapter(fakeCtx({ profileContext: { name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml') } }))
  assert.equal(adapter.profilePath(), dir)
  const plugins = await adapter.listPlugins()
  assert.deepEqual(plugins, [
    { name: '@deepseek-ai/dsh-client-ui-theme', source: 'patch' },
    { name: '@linxin666/dsh-client-ui-skill-explorer', version: '0.4.19', source: 'npm' },
    { name: 'dsh-better-sidebar', source: 'patch' },
    { name: 'dsh-ops', version: '0.5.6', source: 'npm' },
  ])
})

test('listSkills 把宿主 source/provider 归一成 source', async () => {
  const adapter = createHostAdapter(fakeCtx({ skills: fakeSkills() }), NO_DISK_SKILL_ROOTS)
  assert.deepEqual(await adapter.listSkills(), [
    { name: 'brainstorming', source: 'user' },
    { name: 'writing-plans', source: 'bundled' },
  ])
})

test('sessionEvents 只映射 tool/call，并支持 sinceISO 过滤', async () => {
  const adapter = createHostAdapter(fakeCtx({ sessionQuery: fakeSessionQuery() }))
  const iterable = adapter.sessionEvents()
  assert.equal(typeof iterable?.[Symbol.asyncIterator], 'function')
  assert.deepEqual(await collect(iterable), [
    { tool: 'run_code', at: '2026-01-02T03:04:05.000Z', sessionId: 's1' },
    { tool: 'read', at: '2026-01-03T00:00:00.000Z', sessionId: 's1' },
    { tool: 'write', at: '2025-12-31T23:00:00.000Z', sessionId: 's2' },
  ])
  assert.deepEqual(await collect(adapter.sessionEvents('2026-01-01T00:00:00.000Z')), [
    { tool: 'run_code', at: '2026-01-02T03:04:05.000Z', sessionId: 's1' },
    { tool: 'read', at: '2026-01-03T00:00:00.000Z', sessionId: 's1' },
  ])
})

test('sessionEvents（F5）：since 先用 header.createdAt 跳过窗口外会话，缺失 createdAt 保守读取', async () => {
  const reads = []
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 'old', createdAt: '2025-12-01T00:00:00.000Z' } },
        { header: { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' } },
        { header: { id: 'unknown' } },
      ]
    },
    async readSession(sessionId) {
      reads.push(sessionId)
      const time =
        sessionId === 'old' ? Date.UTC(2025, 11, 1) : sessionId === 'new' ? Date.UTC(2026, 0, 3) : Date.UTC(2025, 11, 31)
      return { events: [{ type: 'tool/call', time, data: { name: sessionId } }] }
    },
  }
  const adapter = createHostAdapter(fakeCtx({ sessionQuery }))
  const rows = await collect(adapter.sessionEvents('2026-01-01T00:00:00.000Z'))
  assert.deepEqual(reads, ['new', 'unknown'], '窗口外会话不得 readSession；缺失 createdAt 保守读取')
  assert.deepEqual(rows, [{ tool: 'new', at: '2026-01-03T00:00:00.000Z', sessionId: 'new' }], 'unknown 会话的窗口外事件仍按 event.time 过滤')
  // 不传 since 时行为同旧：三个会话都读
  reads.length = 0
  const all = await collect(adapter.sessionEvents())
  assert.deepEqual(reads, ['old', 'new', 'unknown'])
  assert.deepEqual(all.map((row) => row.tool), ['old', 'new', 'unknown'])
})

test('sessionQuery 缺失时 sessionEvents 返回 null，不抛错', () => {
  const adapter = createHostAdapter(fakeCtx({}))
  assert.equal(adapter.sessionEvents(), null)
})

test('probeHost 服务齐全：计数、profilePath、dshVersion、sessionEvents 可用', async () => {
  const dir = await makeProfileFixture()
  const adapter = createHostAdapter(fakeCtx({
    tools: fakeTools(),
    skills: fakeSkills(),
    sessionQuery: fakeSessionQuery(),
    profileContext: { name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml') },
  }), { dshVersion: '0.2.2-rc.5', ...NO_DISK_SKILL_ROOTS })
  const result = await probeHost(adapter)
  assert.deepEqual(result, {
    tools: 2,
    plugins: 4,
    skills: 2,
    sessionEvents: true,
    profilePath: dir,
    dshVersion: '0.2.2-rc.5',
    warnings: [],
  })
})

test('probeHost 服务缺失：全空降级、有警告、绝不抛错', async () => {
  const warnings = []
  const adapter = createHostAdapter(fakeCtx({}, warnings), { env: {}, argv: [], execPath: '', ...NO_DISK_SKILL_ROOTS })
  const result = await probeHost(adapter)
  assert.deepEqual(result, {
    tools: 0,
    plugins: 0,
    skills: 0,
    sessionEvents: false,
    profilePath: '',
    dshVersion: 'unknown',
    warnings: result.warnings,
  })
  assert.ok(result.warnings.length >= 4, '每项缺失能力都应留下警告')
  assert.ok(warnings.length >= 4, '警告应同时交给 ctx.logger.warn')
  for (const message of result.warnings) assert.ok(message.length > 0)
})

test('服务抛错时逐项降级，不把异常抛给调用方', async () => {
  const ctx = fakeCtx({
    tools: { view() { throw new Error('tools exploded') } },
    skills: { async list() { throw new Error('skills exploded') } },
    sessionQuery: {
      async listSessions() { return [{ header: { id: 'bad' } }, { header: { id: 'good' } }] },
      async readSession(id) {
        if (id === 'bad') throw new Error('unreadable session')
        return { events: [{ type: 'tool/call', time: Date.UTC(2026, 0, 1), data: { name: 'read' } }] }
      },
    },
  })
  const adapter = createHostAdapter(ctx, { dshVersion: 'x', profilePath: '/nonexistent-guizhi-profile', ...NO_DISK_SKILL_ROOTS })
  const result = await probeHost(adapter)
  assert.equal(result.tools, 0)
  assert.equal(result.skills, 0)
  assert.equal(result.sessionEvents, true)
  assert.ok(result.warnings.length >= 2)
  assert.deepEqual(await collect(adapter.sessionEvents()), [
    { tool: 'read', at: '2026-01-01T00:00:00.000Z', sessionId: 'good' },
  ])
})

test('profile 文件不可用时退到 pluginInventory', async () => {
  const adapter = createHostAdapter(fakeCtx({
    pluginInventory: {
      async list() {
        return { entries: [
          { moduleName: 'dshmarket', meta: { version: '1.84.1' } },
          { moduleName: 'dsh-ops' },
        ] }
      },
    },
  }), { env: {}, argv: [], execPath: '' })
  assert.deepEqual(await adapter.listPlugins(), [
    { name: 'dsh-ops', source: 'npm' },
    { name: 'dshmarket', version: '1.84.1', source: 'npm' },
  ])
})

test('detectDshVersion：环境变量优先，其次从 argv 向上找 @deepseek-ai/dsh', async () => {
  assert.equal(detectDshVersion({ env: { DSH_CLIENT_VERSION: '0.2.2-rc.5' }, argv: [], execPath: '' }), '0.2.2-rc.5')
  assert.equal(detectDshVersion({ env: {}, argv: [], execPath: '' }), 'unknown')

  const root = await mkdtemp(join(tmpdir(), 'guizhi-dsh-'))
  cleanup.push(root)
  const deep = join(root, 'resources', 'app.asar', 'dsh', 'lib')
  await mkdir(deep, { recursive: true })
  await writeFile(join(deep, 'bin.js'), '')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' }))
  assert.equal(detectDshVersion({ env: {}, argv: [join(deep, 'bin.js')], execPath: '' }), '0.2.2-rc.5')
})

test('cordis.patch.yml 解析失败：有 warning，且不把结果当成「没装插件」（npm 行保留）', async () => {
  const dir = await makeBrokenPatchFixture()
  const adapter = createHostAdapter(fakeCtx({
    profileContext: { name: 'broken', dir, patchPath: join(dir, 'cordis.patch.yml') },
    // A wrong implementation would treat the unreadable patch as "no plugins"
    // and fall back to this inventory; asserting its entry stays absent proves
    // the npm rows from package.json were kept instead.
    pluginInventory: { async list() { return { entries: [{ moduleName: 'inventory-only-plugin' }] } } },
  }))
  const plugins = await adapter.listPlugins()
  assert.deepEqual(plugins, [{ name: 'dsh-ops', version: '0.5.5', source: 'npm' }])
  const warnings = adapter.warnings
  assert.ok(
    warnings.some((message) => message.includes('读取 profile cordis.patch.yml 失败')),
    'patch 解析失败必须留下明确的 warning：' + JSON.stringify(warnings),
  )
})

test('probeHost warnings 是快照：连续两次不累积，第二次不被第一次污染（Minor 3）', async () => {
  const logged = []
  const adapter = createHostAdapter(fakeCtx({}, logged), { env: {}, argv: [], execPath: '', ...NO_DISK_SKILL_ROOTS })
  const first = await probeHost(adapter)
  assert.ok(first.warnings.length >= 4, '缺失能力应有警告：' + JSON.stringify(first.warnings))
  assert.deepEqual(adapter.warnings, [], '一次 probe 结束后 adapter 内部队列应已清空')
  const second = await probeHost(adapter)
  assert.notStrictEqual(second.warnings, first.warnings, 'warnings 必须是每次调用的独立快照')
  assert.deepEqual(second.warnings, first.warnings, '第二次结果不应追加第一次的历史警告')
  first.warnings.push('调用方篡改')
  const third = await probeHost(adapter)
  assert.deepEqual(third.warnings, second.warnings, '调用方改 result.warnings 不得影响后续探测')
  assert.deepEqual(adapter.warnings, [], 'adapter.warnings 应是只读快照，不暴露内部队列')
  assert.deepEqual(adapter.takeWarnings(), [], 'takeWarnings 取走后必须为空')
})

test('profileContext 缺失：profilePath 走 env DSH_PROFILE / argv --profile 兜底', async () => {
  const home = join(tmpdir(), 'guizhi-home-fallback')
  const viaEnv = createHostAdapter(fakeCtx({}), { env: { DSH_PROFILE: 'env-profile', DSH_HOME: home }, argv: [] })
  assert.equal(viaEnv.profilePath(), join(home, 'profiles', 'env-profile'))

  const viaArgv = createHostAdapter(fakeCtx({}), { env: {}, argv: ['node', 'dsh', '--profile', 'argv-profile'], home })
  assert.equal(viaArgv.profilePath(), join(home, 'profiles', 'argv-profile'))

  const ctxWins = createHostAdapter(
    fakeCtx({ profileContext: { dir: join(home, 'from-context') } }),
    { env: { DSH_PROFILE: 'env-profile', DSH_HOME: home }, argv: [] },
  )
  assert.equal(ctxWins.profilePath(), join(home, 'from-context'))

  assert.equal(resolveProfilePath(fakeCtx({}), { env: {}, argv: [], home }), '')
  assert.equal(detectProfileName(['node', 'dsh', '--profile', 'name-a']), 'name-a')
  assert.equal(detectProfileName(['node', 'dsh', '--profile=name-b']), 'name-b')
  assert.equal(detectProfileName(['node', 'dsh', '--profile']), '')
  assert.equal(detectProfileName(['node', 'dsh', '--profile', '--other']), '')
  assert.equal(detectProfileName(undefined), '')
})
// ---------------------------------------------------------------------------
// Data root resolution (fix round 1, R-7A Important 5 / D16 revision)
// ---------------------------------------------------------------------------

test('resolveDshHome：显式 home > $DSH_HOME > ~/.dsh 默认（与 profile 解析一致）', () => {
  assert.equal(resolveDshHome({ home: 'F:/explicit-home', env: { DSH_HOME: 'F:/env-home' } }), 'F:/explicit-home')
  assert.equal(resolveDshHome({ env: { DSH_HOME: 'F:/env-home' } }), 'F:/env-home')
  assert.equal(resolveDshHome({ env: {} }), join(homedir(), '.dsh'))
  assert.equal(resolveDshHome({ env: { DSH_HOME: '   ' } }), join(homedir(), '.dsh'))
})

test('resolveDataRoot：dshHomePath(guizhi) > profileContext.home > $DSH_HOME > ~/.dsh/guizhi', async () => {
  const viaService = resolveDataRoot(fakeCtx({ dshHomePath: (segment) => join('F:/host-home', segment) }), { env: {} })
  assert.equal(viaService, join('F:/host-home', 'guizhi'))

  const viaProfile = resolveDataRoot(
    fakeCtx({ profileContext: { home: 'F:/profile-home' } }),
    { env: { DSH_HOME: 'F:/env-home' } },
  )
  assert.equal(viaProfile, join('F:/profile-home', 'guizhi'))

  const viaEnv = resolveDataRoot(fakeCtx({}), { env: { DSH_HOME: 'F:/env-home' } })
  assert.equal(viaEnv, join('F:/env-home', 'guizhi'))

  const fallback = resolveDataRoot(fakeCtx({}), { env: {} })
  assert.equal(fallback, join(homedir(), '.dsh', 'guizhi'))

  const throwing = resolveDataRoot(
    fakeCtx({ dshHomePath: () => { throw new Error('boom') }, profileContext: { home: 'F:/profile-home' } }),
    { env: {} },
  )
  assert.equal(throwing, join('F:/profile-home', 'guizhi'), 'dshHomePath 抛错时降级到 profileContext.home')

  const blank = resolveDataRoot(fakeCtx({ dshHomePath: () => '   ' }), { env: { DSH_HOME: 'F:/env-home' } })
  assert.equal(blank, join('F:/env-home', 'guizhi'), '空路径结果降级到下一级')
})

test('dispatchSupport：缺服务时不可用且给出原因，服务齐全时可用', () => {
  const missing = createHostAdapter(fakeCtx({}))
  const denied = missing.dispatchSupport()
  assert.equal(denied.available, false)
  assert.equal(typeof denied.reason, 'string')
  assert.match(denied.reason, /sessionController/)
  const controller = { create: async () => ({ sessionId: 's1' }), prompt: async () => ({ accepted: true }) }
  const ready = createHostAdapter(fakeCtx({ sessionController: controller, sessionQuery: { readSession: async () => ({ events: [] }) } }))
  assert.equal(ready.dispatchSupport().available, true)
})

test('createDispatchSession / promptDispatchSession 使用固定的 sessionController 形状', async () => {
  const calls = []
  const controller = {
    create: async (request) => { calls.push(['create', request]); return { sessionId: 's9' } },
    prompt: async (request, signal) => { calls.push(['prompt', request, signal instanceof AbortSignal]); return { accepted: true } },
  }
  const adapter = createHostAdapter(fakeCtx({ sessionController: controller, sessionQuery: { readSession: async () => ({ events: [] }) } }))
  const sessionId = await adapter.createDispatchSession()
  assert.equal(sessionId, 's9')
  assert.deepEqual(calls[0], ['create', {}])
  await adapter.promptDispatchSession({ sessionId, requestId: 'r9', text: 'do it' })
  assert.deepEqual(calls[1][1], { sessionId: 's9', requestId: 'r9', content: [{ type: 'text', text: 'do it' }], mode: 'queue' })
  assert.equal(calls[1][2], true, 'prompt 必须收到 AbortSignal')
})

test('readDispatchEvents：三态返回 events / missing / unreadable，warning 只记一次', async () => {
  const adapter = createHostAdapter(fakeCtx({ sessionQuery: { readSession: async () => ({ events: [{ seq: 1 }] }) } }))
  assert.deepEqual(await adapter.readDispatchEvents('s1'), { status: 'events', events: [{ seq: 1 }] })
  const missing = createHostAdapter(fakeCtx({ sessionQuery: { readSession: async () => { throw Object.assign(new Error('session "s1" not found'), { code: 'session/not-found' }) } } }))
  assert.deepEqual(await missing.readDispatchEvents('s1'), { status: 'missing' })
  const failing = createHostAdapter(fakeCtx({ sessionQuery: { readSession: async () => { throw new Error('gone') } } }))
  assert.deepEqual(await failing.readDispatchEvents('s1'), { status: 'unreadable', error: 'gone' })
  await failing.readDispatchEvents('s1')
  assert.equal(failing.warnings.filter((message) => message.includes('后台会话')).length, 1)
  const absent = createHostAdapter(fakeCtx({}))
  assert.equal((await absent.readDispatchEvents('s1')).status, 'unreadable')
})

test('promptDispatchSession：host 报 session 不存在时带 DISPATCH_SESSION_MISSING 码抛出', async () => {
  const controller = {
    create: async () => ({ sessionId: 's1' }),
    prompt: async () => { throw Object.assign(new Error('session "s1" not found'), { code: 'session/not-found' }) },
  }
  const adapter = createHostAdapter(fakeCtx({ sessionController: controller }))
  await assert.rejects(adapter.promptDispatchSession({ sessionId: 's1', requestId: 'r1', text: 'x' }), (error) => error.code === 'DISPATCH_SESSION_MISSING')
})


