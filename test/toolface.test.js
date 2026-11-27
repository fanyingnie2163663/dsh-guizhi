import test from 'node:test'
import assert from 'node:assert/strict'
import { withAttribution } from '../lib/attribution.js'
import { createHostAdapter } from '../lib/host.js'
import { createToolFaceController } from '../lib/toolface.js'

/**
 * Tool-face controller tests (S3): a fake agent-scoped tools registry records
 * the restrict() request and can emulate leaked own-scope tools the host cannot
 * hide. lib/toolface.js is pure logic over injected glue, so no host import is
 * needed here.
 */

/** Fake host tools service + agent scope sharing one restrict() implementation. */
function createFakeTools(options = {}) {
  const restrictable = Array.isArray(options.restrictable) ? options.restrictable : ['read', 'grep', 'stow_scan']
  const leaked = Array.isArray(options.leaked) ? options.leaked : []
  const state = { restrictCalls: [], restores: 0, restricted: null, viewCalls: 0 }
  const visibleNames = () => (state.restricted === null ? restrictable.slice() : [...state.restricted.allowed, ...leaked])
  return {
    state,
    view(scope) {
      state.viewCalls += 1
      state.scope = scope
      return {
        visible: new Map(visibleNames().map((name) => [name, { name }])),
        restrictableNames: new Set(restrictable),
      }
    },
    restrict(restriction) {
      state.restrictCalls.push(JSON.parse(JSON.stringify(restriction)))
      state.restricted = { allowed: Array.isArray(restriction?.allow) ? restriction.allow.slice() : [] }
      return () => {
        state.restores += 1
        state.restricted = null
      }
    },
  }
}

function createAgent(sessionId, tools, options = {}) {
  const agent = {}
  if (sessionId !== undefined) {
    agent.id = sessionId
    agent.session = { id: sessionId }
  }
  if (options.scoped !== false) agent.ctx = { tools }
  return agent
}

function createHarness(options = {}) {
  const warnings = []
  const tools = options.tools === undefined ? createFakeTools(options.toolsOptions) : options.tools
  const getTools = options.getTools === undefined ? () => tools : options.getTools
  const controller = createToolFaceController({ getTools, warn: (message) => warnings.push(String(message)) })
  return { controller, tools, warnings, getTools }
}

test('plan + onCreated：allow 过滤为可限制工具，调用 restrict({allow}) 并返回 applied/allowed/skipped', () => {
  const { controller, tools, warnings } = createHarness()
  const agent = createAgent('session-1', tools)
  assert.equal(controller.plan('session-1', ['read', 'grep', 'not-a-tool']), true)
  const result = controller.onCreated(agent)
  assert.equal(result.applied, true)
  assert.deepEqual(result.allowed, ['read', 'grep'])
  assert.deepEqual(result.skipped, ['not-a-tool'])
  assert.deepEqual(result.leaked, [])
  assert.deepEqual(tools.state.restrictCalls, [{ allow: ['read', 'grep'] }])
  assert.equal(tools.state.scope, agent.ctx, 'view 必须取 agent scoped ctx')
  assert.deepEqual(warnings, [])
})

test('无 pending 时 onCreated 是 no-op：不取视图、不调用 restrict', () => {
  const { controller, tools } = createHarness()
  const agent = createAgent('session-1', tools)
  assert.equal(controller.onCreated(agent), null)
  assert.equal(tools.state.viewCalls, 0)
  assert.deepEqual(tools.state.restrictCalls, [])
})

test('plan 去重且只收字符串：空串/非字符串被忽略；forget 后不再生效', () => {
  const { controller, tools } = createHarness()
  const agent = createAgent('session-1', tools)
  assert.equal(controller.plan('session-1', ['read', 'read', 42, null, '', ' grep ', { name: 'x' }]), true)
  assert.deepEqual(controller.onCreated(agent).allowed, ['read', 'grep'])
  // 第二次会话：forget 清掉 pending
  controller.plan('session-2', ['read'])
  assert.equal(controller.forget('session-2'), true)
  assert.equal(controller.onCreated(createAgent('session-2', tools)), null)
  assert.equal(controller.forget('session-2'), false, '重复 forget 返回 false')
})

test('session id 取 agent.session.id；缺失时退回 agent.id', () => {
  const { controller, tools } = createHarness()
  controller.plan('fallback-id', ['read'])
  const agent = createAgent(undefined, tools)
  agent.id = 'fallback-id'
  const result = controller.onCreated(agent)
  assert.equal(result.applied, true)
  assert.deepEqual(result.allowed, ['read'])
})

test('宿主没有 tools / view 时降级为 {applied:false} + warning，不抛错', () => {
  const { controller, warnings } = createHarness({ getTools: () => undefined })
  controller.plan('session-1', ['read'])
  const result = controller.onCreated(createAgent('session-1', {}))
  assert.equal(result.applied, false)
  assert.equal(typeof result.reason, 'string')
  assert.ok(warnings.length > 0, '必须有可读 warning')
  const noView = createHarness({ getTools: () => ({}) })
  noView.controller.plan('session-1', ['read'])
  const viewless = noView.controller.onCreated(createAgent('session-1', {}))
  assert.equal(viewless.applied, false)
  assert.ok(noView.warnings.length > 0)
})

test('getTools 抛错时降级，不把异常抛给宿主', () => {
  const { controller, warnings } = createHarness({ getTools: () => { throw new Error('registry boom') } })
  controller.plan('session-1', ['read'])
  const result = controller.onCreated(createAgent('session-1', {}))
  assert.equal(result.applied, false)
  assert.match(warnings.join('\n'), /registry boom|失败/)
})

test('agent 缺少 scoped ctx 或 ctx.tools.restrict 时降级 + warning', () => {
  const { controller, tools, warnings } = createHarness()
  controller.plan('session-1', ['read'])
  const noCtx = controller.onCreated({ session: { id: 'session-1' } })
  assert.equal(noCtx.applied, false)
  controller.plan('session-2', ['read'])
  const result = controller.onCreated({ session: { id: 'session-2' }, ctx: { tools: {} } })
  assert.equal(result.applied, false)
  assert.match(warnings.join('\n'), /restrict|工具面/)
  assert.deepEqual(tools.state.restrictCalls, [])
})

test('restrictableNames 不可读时降级 + warning', () => {
  const tools = { view: () => ({ visible: new Map() }), restrict: () => () => {} }
  const { controller, warnings } = createHarness({ tools })
  controller.plan('session-1', ['read'])
  const result = controller.onCreated(createAgent('session-1', tools))
  assert.equal(result.applied, false)
  assert.ok(warnings.length > 0)
})

test('allow 与可限制工具没有交集：warning + 不调用 restrict', () => {
  const { controller, tools, warnings } = createHarness()
  controller.plan('session-1', ['run_code', 'not-a-tool'])
  const result = controller.onCreated(createAgent('session-1', tools))
  assert.equal(result.applied, false)
  assert.deepEqual(result.skipped, ['run_code', 'not-a-tool'])
  assert.deepEqual(tools.state.restrictCalls, [])
  assert.match(warnings.join('\n'), /无交集|没有可限制/)
})

test('restrict 抛错时降级 + warning，不抛给宿主', () => {
  const tools = createFakeTools()
  tools.restrict = () => { throw new Error('restrict unsupported') }
  const { controller, warnings } = createHarness({ tools })
  controller.plan('session-1', ['read'])
  const result = controller.onCreated(createAgent('session-1', tools))
  assert.equal(result.applied, false)
  assert.match(warnings.join('\n'), /restrict unsupported|失败/)
})

test('restrict 后仍可见的清单外可限制工具：不报错，但 warning + leaked', () => {
  const { controller, tools, warnings } = createHarness({ toolsOptions: { leaked: ['stow_scan'] } })
  controller.plan('session-1', ['read'])
  const result = controller.onCreated(createAgent('session-1', tools))
  assert.equal(result.applied, true)
  assert.deepEqual(result.leaked, ['stow_scan'])
  assert.match(warnings.join('\n'), /仍可见|stow_scan/)
})

test('agent/disposed：调用 disposer 一次并清理；无 disposer 时不抛错', () => {
  const { controller, tools } = createHarness()
  controller.plan('session-1', ['read'])
  const agent = createAgent('session-1', tools)
  controller.onCreated(agent)
  assert.equal(tools.state.restores, 0)
  assert.equal(controller.onDisposed(agent), true)
  assert.equal(tools.state.restores, 1)
  assert.equal(controller.onDisposed(agent), false, '重复 disposed 不重复释放')
  assert.equal(controller.onDisposed({}), false, '未知 agent 安全返回')
  // disposer 为 {dispose()} 对象时也能释放
  const objectTools = createFakeTools()
  const disposable = { count: 0, dispose() { this.count += 1 } }
  objectTools.restrict = () => disposable
  const other = createHarness({ tools: objectTools })
  other.controller.plan('session-9', ['read'])
  const secondAgent = createAgent('session-9', objectTools)
  other.controller.onCreated(secondAgent)
  assert.equal(other.controller.onDisposed(secondAgent), true)
  assert.equal(disposable.count, 1)
})

test('dispose()：释放全部 disposer、清空 pending，之后 plan/onCreated 不再生效', () => {
  const { controller, tools } = createHarness()
  const agentA = createAgent('session-a', tools)
  const agentB = createAgent('session-b', tools)
  controller.plan('session-a', ['read'])
  controller.plan('session-b', ['grep'])
  controller.onCreated(agentA)
  controller.onCreated(agentB)
  controller.plan('session-pending', ['read'])
  controller.dispose()
  assert.equal(tools.state.restores, 2)
  assert.equal(controller.plan('session-c', ['read']), false)
  assert.equal(controller.onCreated(createAgent('session-c', tools)), null)
})

test('disposer 抛错时 is dispose 隔离：继续释放其它 agent，不抛给宿主', () => {
  const tools = createFakeTools()
  let calls = 0
  tools.restrict = () => () => {
    calls += 1
    throw new Error('undo failed')
  }
  const { controller, warnings } = createHarness({ tools })
  const agentA = createAgent('session-a', tools)
  const agentB = createAgent('session-b', tools)
  controller.plan('session-a', ['read'])
  controller.plan('session-b', ['grep'])
  controller.onCreated(agentA)
  controller.onCreated(agentB)
  controller.dispose()
  assert.equal(calls, 2, '一个 disposer 失败不能阻断另一个')
  assert.match(warnings.join('\n'), /undo failed|清理/)
})

/* ------------------------------------------------- host 适配器接线 */

/** Fake cordis plugin ctx with the pieces createHostAdapter resolves. */
function createFakeCordis(services = {}) {
  const listeners = new Map()
  const effects = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    get(name) {
      return Object.hasOwn(services, name) ? services[name] : undefined
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(fn, label) {
      effects.push({ fn, label })
      return () => {}
    },
  }
  return {
    ctx,
    effects,
    warnings,
    emit(event, payload) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload)
    },
  }
}

test('host 适配器：ctx.on 钩子应用 allowlist、disposed 释放、effect 卸载清理与预生成 session id', async () => {
  const tools = createFakeTools()
  const services = { tools }
  const cordis = createFakeCordis(services)
  const sessionController = {
    calls: [],
    async create(request) {
      this.calls.push(request)
      return { sessionId: typeof request?.sessionId === 'string' ? request.sessionId : 'generated-session' }
    },
    async prompt() {},
  }
  services.sessionController = sessionController
  const adapter = createHostAdapter(cordis.ctx, { env: {}, argv: [], execPath: '' })
  assert.deepEqual(adapter.toolFaceSupport(), { available: true })
  assert.equal(adapter.prepareWorkerToolFace('session-h1', ['read', 'grep', 'run_code']), true)
  const agent = { session: { id: 'session-h1' }, ctx: { tools } }
  cordis.emit('agent/created', { agent })
  assert.deepEqual(tools.state.restrictCalls, [{ allow: ['read', 'grep'] }], 'agent/created 应用 allowlist')
  cordis.emit('agent/disposed', { agent })
  assert.equal(tools.state.restores, 1, 'agent/disposed 释放限制')
  // createDispatchSession 透传预生成 id；不带参数时保持旧行为
  assert.equal(await adapter.createDispatchSession({ sessionId: 'session-h2' }), 'session-h2')
  assert.deepEqual(sessionController.calls, [{ sessionId: 'session-h2' }])
  assert.equal(await adapter.createDispatchSession(), 'generated-session')
  // 插件卸载：仍在生效的限制由 ctx.effect 清理
  assert.equal(adapter.prepareWorkerToolFace('session-h3', ['read']), true)
  const agent3 = { session: { id: 'session-h3' }, ctx: { tools } }
  cordis.emit('agent/created', { agent: agent3 })
  const cleanup = cordis.effects.find((entry) => typeof entry.fn === 'function')
  assert.ok(cleanup !== undefined, 'ctx.effect 必须注册卸载清理')
  assert.equal(typeof cleanup.fn(), 'function')
  cleanup.fn()()
  assert.equal(tools.state.restores, 2)
  // 卸载后再 plan 不再生效
  assert.equal(adapter.prepareWorkerToolFace('session-h4', ['read']), false)
})

test('host 适配器：缺 ctx.on / restrictableNames 时 toolFaceSupport=false，prepare 降级且同一原因只 warning 一次', () => {
  const tools = createFakeTools()
  const warnings = []
  const ctxNoHooks = {
    logger: { warn: (message) => warnings.push(String(message)) },
    get(name) {
      return name === 'tools' ? tools : undefined
    },
  }
  const adapter = createHostAdapter(ctxNoHooks, { env: {}, argv: [], execPath: '' })
  const support = adapter.toolFaceSupport()
  assert.equal(support.available, false)
  assert.match(support.reason, /ctx\.on/)
  assert.equal(adapter.prepareWorkerToolFace('s1', ['read']), false)
  assert.equal(adapter.prepareWorkerToolFace('s2', ['read']), false)
  assert.equal(
    warnings.filter((message) => message.includes('工具面限制') || message.includes('软约束')).length,
    1,
    '同一不可用原因只 warning 一次：' + warnings.join(' | '),
  )
  // 有 hooks 但工具视图没有 restrictableNames → 仍判不可用
  const cordis = createFakeCordis({ tools: { view: () => ({ visible: new Map() }) } })
  const adapter2 = createHostAdapter(cordis.ctx, { env: {}, argv: [], execPath: '' })
  assert.equal(adapter2.toolFaceSupport().available, false)
  assert.match(adapter2.toolFaceSupport().reason, /restrictableNames/)
})

test('withAttribution 透传 S3 工具面方法（真实插件接线 deps.host 必备）', () => {
  const calls = []
  const host = {
    profilePath: () => '/nonexistent-guizhi-profile',
    get warnings() {
      return []
    },
    toolFaceSupport: () => {
      calls.push('support')
      return { available: true }
    },
    prepareWorkerToolFace: (sessionId, allowedTools) => {
      calls.push(['prepare', sessionId, allowedTools])
      return true
    },
    forgetWorkerToolFace: (sessionId) => {
      calls.push(['forget', sessionId])
    },
    createDispatchSession: async (options) => {
      calls.push(['create', options])
      return 'session-x'
    },
  }
  const wrapped = withAttribution(host, { profilePath: '/nonexistent-guizhi-profile' })
  assert.deepEqual(wrapped.toolFaceSupport(), { available: true })
  assert.equal(wrapped.prepareWorkerToolFace('session-x', ['read']), true)
  wrapped.forgetWorkerToolFace('session-x')
  assert.deepEqual(calls, ['support', ['prepare', 'session-x', ['read']], ['forget', 'session-x']])
})

test('host 适配器：ctx.on 注册抛错时 toolFaceSupport=false（不假装 applied）', () => {
  const tools = createFakeTools()
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    get(name) {
      return name === 'tools' ? tools : undefined
    },
    on() {
      throw new Error('event bus closed')
    },
    effect() {},
  }
  const adapter = createHostAdapter(ctx, { env: {}, argv: [], execPath: '' })
  const support = adapter.toolFaceSupport()
  assert.equal(support.available, false)
  assert.match(support.reason, /生命周期钩子/)
  assert.equal(adapter.prepareWorkerToolFace('session-x', ['read']), false)
  assert.match(warnings.join(' | '), /event bus closed/)
})



