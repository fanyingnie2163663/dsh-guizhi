/**
 * Worker tool-face restriction (S3, experimental).
 *
 * A pack-dispatch asks the host to shrink the tool surface of the background
 * worker Session to the tools its capability pack declares. The host contract
 * (verified on a dsh-ops precedent, not yet on the real product):
 *
 * - `ctx.on('agent/created', ({ agent }) => ...)` / `agent/disposed` fire for
 *   every Agent, and `agent.ctx` is the Agent-scoped context;
 * - `agent.session.id` is the Session id (with `agent.id` as a fallback);
 * - `agent.ctx.tools.restrict({ allow })` accepts an allowlist whose names must
 *   be a subset of `tools.view(agent.ctx).restrictableNames`; it returns a
 *   disposer that restores the previous surface.
 *
 * This module is pure logic over injected glue: `getTools` returns the host
 * tools service and `warn` records a readable diagnostic. Nothing here throws
 * into the plugin or the Agent lifecycle: every unsupported or failing branch
 * degrades to `{ applied: false, reason }` plus a warning, so the dispatch
 * itself can always fall back to a soft-constraint worker.
 *
 * Known host limits (reported, never fatal): tools registered in the Agent's own
 * scope are not hidden by `restrict`, and the host may exempt some tools, so a
 * post-restrict `view` can still list restrictable names outside the allowlist.
 *
 * @module @fanyingnie/dsh-guizhi/toolface
 */

/**
 * Normalize a pack tool list into an allowlist: strings only, trimmed, empty
 * entries dropped and duplicates removed (order preserved).
 * @param {unknown} allowTools
 * @returns {string[]}
 */
export function normalizeAllowedTools(allowTools) {
  const names = []
  const seen = new Set()
  for (const raw of Array.isArray(allowTools) ? allowTools : []) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/** Describe an unknown error without a stack. @param {unknown} error */
function describeError(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error)
  return text === '' ? 'unknown error' : text
}

/**
 * Release one host registration: a function disposer, `{ dispose() }` or
 * `{ release() }`. Returns whether something was released.
 * @param {unknown} disposer
 * @returns {boolean}
 */
function disposeRegistration(disposer) {
  if (typeof disposer === 'function') {
    disposer()
    return true
  }
  if (disposer !== null && typeof disposer === 'object') {
    if (typeof disposer.dispose === 'function') {
      disposer.dispose()
      return true
    }
    if (typeof disposer.release === 'function') {
      disposer.release()
      return true
    }
  }
  return false
}

/** @param {unknown} agent @returns {string} Agent session id, or '' when unknown. */
function sessionIdOf(agent) {
  if (agent === null || typeof agent !== 'object') return ''
  const session = agent.session
  if (session !== null && typeof session === 'object' && typeof session.id === 'string' && session.id !== '') return session.id
  return typeof agent.id === 'string' && agent.id !== '' ? agent.id : ''
}

/** @param {unknown} view @returns {Set<string> | null} restrictable names, or null when the host does not expose them. */
function restrictableSetOf(view) {
  const raw = view !== null && typeof view === 'object' ? view.restrictableNames : undefined
  if (raw instanceof Set) {
    const names = new Set()
    for (const name of raw) if (typeof name === 'string' && name !== '') names.add(name)
    return names
  }
  if (Array.isArray(raw)) return new Set(raw.filter((name) => typeof name === 'string' && name !== ''))
  return null
}

/** @param {unknown} view @returns {string[]} visible tool names. */
function visibleNamesOf(view) {
  const visible = view !== null && typeof view === 'object' ? view.visible : undefined
  if (visible instanceof Map) return [...visible.keys()].map((name) => String(name))
  if (visible !== null && typeof visible === 'object') return Object.keys(visible)
  return []
}

/**
 * Create the tool-face controller for one plugin load.
 *
 * @param {{ getTools?: () => unknown, warn?: (message: string) => void }} [options]
 * @returns {{
 *   plan: (sessionId: string, allowTools: unknown) => boolean,
 *   forget: (sessionId: string) => boolean,
 *   onCreated: (agent: unknown) => ({ applied: boolean, reason?: string, allowed?: string[], skipped?: string[], leaked?: string[] } | null),
 *   onDisposed: (agent: unknown) => boolean,
 *   dispose: () => void,
 * }}
 */
export function createToolFaceController(options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const getTools = typeof source.getTools === 'function' ? source.getTools : () => undefined
  const safeWarn = typeof source.warn === 'function' ? source.warn : () => {}

  /** @param {string} message */
  const report = (message) => {
    try {
      safeWarn(String(message))
    } catch {
      // A throwing warning sink must not break the Agent lifecycle.
    }
  }

  /** Session id -> requested allowlist, recorded before the Session exists. */
  const pending = new Map()
  /** Agent object -> disposer returned by the host's restrict(). */
  const disposers = new Map()
  let disposed = false

  /**
   * Record the allowlist a just-requested worker Session should receive.
   * The id is the value the dispatcher will pass to sessionController.create.
   * @param {string} sessionId
   * @param {unknown} allowTools
   * @returns {boolean} whether the plan was recorded.
   */
  const plan = (sessionId, allowTools) => {
    if (disposed) return false
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return false
    pending.set(sessionId, normalizeAllowedTools(allowTools))
    return true
  }

  /**
   * Drop one planned allowlist (the create() call never used the planned id, or
   * the dispatch failed before the Session existed).
   * @param {string} sessionId
   * @returns {boolean}
   */
  const forget = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    return pending.delete(sessionId)
  }

  /**
   * Apply the pending allowlist to a newly created Agent. No pending plan for its
   * Session means this is an unrelated Agent, so the call is a no-op.
   * @param {unknown} agent
   * @returns {{ applied: boolean, reason?: string, allowed?: string[], skipped?: string[], leaked?: string[] } | null}
   */
  const onCreated = (agent) => {
    if (disposed) return null
    const sessionId = sessionIdOf(agent)
    if (sessionId === '' || !pending.has(sessionId)) return null
    const requested = pending.get(sessionId)
    pending.delete(sessionId)
    const fallback = { applied: false, allowed: [], skipped: requested.slice() }
    if (agent === null || typeof agent !== 'object' || agent.ctx === null || typeof agent.ctx !== 'object') {
      report('工具面限制跳过：agent 缺少 scoped ctx，worker 仍按软约束运行')
      return { ...fallback, reason: 'agent-ctx-unavailable' }
    }
    let tools
    try {
      tools = getTools()
    } catch (error) {
      report('工具面限制跳过：读取宿主 tools 服务失败（' + describeError(error) + '），worker 仍按软约束运行')
      return { ...fallback, reason: 'tools-unavailable' }
    }
    if (tools === null || typeof tools !== 'object' || typeof tools.view !== 'function') {
      report('工具面限制跳过：宿主 tools 服务缺少 view，worker 仍按软约束运行')
      return { ...fallback, reason: 'tools-unavailable' }
    }
    let view
    try {
      view = tools.view(agent.ctx)
    } catch (error) {
      report('工具面限制跳过：读取 agent 工具视图失败（' + describeError(error) + '），worker 仍按软约束运行')
      return { ...fallback, reason: 'view-failed' }
    }
    const known = restrictableSetOf(view)
    if (known === null) {
      report('工具面限制跳过：宿主工具视图没有 restrictableNames，无法确定可限制工具，worker 仍按软约束运行')
      return { ...fallback, reason: 'restrictable-names-unavailable' }
    }
    const allowed = requested.filter((name) => known.has(name))
    const skipped = requested.filter((name) => !known.has(name))
    if (allowed.length === 0) {
      report(
        '工具面限制跳过：装配清单工具与宿主可限制工具无交集' +
          (skipped.length > 0 ? '（清单工具：' + skipped.join('、') + '）' : '') +
          '，worker 仍按软约束运行',
      )
      return { applied: false, reason: 'no-restrictable-tools', allowed, skipped }
    }
    const scopedTools = agent.ctx.tools
    const restrict = scopedTools !== null && typeof scopedTools === 'object' && typeof scopedTools.restrict === 'function' ? scopedTools.restrict : null
    if (restrict === null) {
      report('工具面限制跳过：agent scoped ctx 缺少 tools.restrict，worker 仍按软约束运行')
      return { applied: false, reason: 'restrict-unavailable', allowed, skipped }
    }
    let disposer
    try {
      disposer = restrict.call(scopedTools, { allow: allowed })
    } catch (error) {
      report('工具面限制失败：' + describeError(error) + '（worker 仍按软约束运行）')
      return { applied: false, reason: 'restrict-failed', allowed, skipped }
    }
    const previous = disposers.get(agent)
    if (previous !== undefined) {
      disposers.delete(agent)
      try {
        disposeRegistration(previous)
      } catch {
        // Replacing a stale registration never blocks the new one.
      }
    }
    disposers.set(agent, disposer)
    // The host cannot hide tools registered in the Agent's own scope (and may
    // exempt others); report what stays visible instead of claiming success.
    let leaked = []
    try {
      const after = tools.view(agent.ctx)
      const afterNames = visibleNamesOf(after)
      leaked = [...new Set(afterNames.filter((name) => known.has(name) && !allowed.includes(name)))]
    } catch {
      // An unreadable post-view does not undo an applied restriction.
    }
    if (leaked.length > 0) {
      report('工具面限制部分生效：以下清单外工具仍可见（宿主自身层/豁免工具，restrict 无法隐藏，请勿使用）：' + leaked.join('、'))
    }
    return { applied: true, allowed, skipped, leaked }
  }

  /**
   * Release one Agent's restriction. Safe for unknown Agents and repeated calls.
   * @param {unknown} agent
   * @returns {boolean} whether a registration existed for this Agent.
   */
  const onDisposed = (agent) => {
    if (agent === null || typeof agent !== 'object') return false
    const sessionId = sessionIdOf(agent)
    if (sessionId !== '') pending.delete(sessionId)
    if (!disposers.has(agent)) return false
    const disposer = disposers.get(agent)
    disposers.delete(agent)
    try {
      disposeRegistration(disposer)
    } catch (error) {
      report('工具面限制清理失败：' + describeError(error))
    }
    return true
  }

  /** Release every restriction and drop all pending plans (plugin unload). */
  const dispose = () => {
    disposed = true
    for (const [agent, disposer] of [...disposers.entries()]) {
      disposers.delete(agent)
      try {
        disposeRegistration(disposer)
      } catch (error) {
        report('工具面限制清理失败：' + describeError(error))
      }
    }
    pending.clear()
  }

  return { plan, forget, onCreated, onDisposed, dispose }
}
