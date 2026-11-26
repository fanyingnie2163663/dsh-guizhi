import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostAdapter, detectDshVersion } from '../lib/host.js'
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
  const adapter = createHostAdapter(fakeCtx({ skills: fakeSkills() }))
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
  }), { dshVersion: '0.2.2-rc.5' })
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
  const adapter = createHostAdapter(fakeCtx({}, warnings), { env: {}, argv: [], execPath: '' })
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
  const adapter = createHostAdapter(ctx, { dshVersion: 'x', profilePath: '/nonexistent-guizhi-profile' })
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
