/**
 * Guizhi · host half.
 *
 * The plugin row inserted by cordis.patch.yml loads this module. It exports no
 * hard service dependency (`inject = []`): every host service is optional and
 * resolved defensively, so a host without tools loads the plugin with a
 * warning instead of failing the profile.
 *
 * Task 0 delivers the scaffold plus the read-only capability probe:
 * - `stow_probe` tool: returns the HostAdapter probe as JSON.
 *
 * No HTTP route is registered here: Task 0 ships no endpoints, and Task 7
 * implements the `/api/guizhi` routes (with tests) once they are in scope.
 *
 * @module @fanyingnie/dsh-guizhi
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHostAdapter, describeError } from './host.js'
import { probeHost } from './probe.js'

/** Cordis plugin name (the package specifier lives in cordis.patch.yml). */
export const name = 'dsh-guizhi'

/**
 * No mandatory dependency: `tools` is mounted through the optional
 * `ctx.inject([...], cb)` form, everything else through protected `ctx.get`.
 * `inject` stays empty so the row needs no `inject` list in cordis.patch.yml.
 */
export const inject = []

const PROBE_TOOL_NAME = 'stow_probe'

/**
 * Warn through the host logger, falling back to console: a degraded capability
 * is always announced, never silently dropped.
 * @param {*} ctx
 * @param {string} message
 */
function warn(ctx, message) {
  const text = '[guizhi] ' + message
  try {
    if (ctx && typeof ctx.logger?.warn === 'function') ctx.logger.warn(text)
    else if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(text)
  } catch {
    // Logging must never break plugin load.
  }
}

/**
 * Register the read-only `stow_probe` tool in a scope that injects `tools`.
 * @param {*} ctx
 * @param {import('./host.js').HostAdapter} adapter
 */
function registerProbeTool(ctx, adapter) {
  if (typeof ctx?.inject !== 'function') {
    warn(ctx, 'ctx.inject 不可用：stow_probe 未注册（宿主不提供 tools 注入）')
    return
  }
  try {
    ctx.inject(['tools'], (scope) => {
      try {
        scope.tools.register(defineTool({
          name: PROBE_TOOL_NAME,
          description: '探测当前 DSH 宿主能力：已注册工具数、插件数、技能数、会话工具事件来源是否可用、profile 路径与 DSH 版本。只读，返回 JSON。',
          parameters: {},
          output: {
            schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          isConcurrencySafe: () => true,
          async execute() {
            const result = await probeHost(adapter)
            return { text: JSON.stringify(result) }
          },
        }))
      } catch (error) {
        warn(ctx, `注册 ${PROBE_TOOL_NAME} 失败：${describeError(error)}`)
      }
    })
  } catch (error) {
    warn(ctx, `tools 注入失败：${describeError(error)}`)
  }
}

/**
 * Mount the Guizhi host half on one plugin load.
 * @param {*} ctx cordis plugin context
 * @param {{ profilePath?: string, dshVersion?: string }} [config] optional patch-row config overrides
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const adapter = createHostAdapter(ctx, {
    ...(typeof config?.profilePath === 'string' && config.profilePath !== '' ? { profilePath: config.profilePath } : {}),
    ...(typeof config?.dshVersion === 'string' && config.dshVersion !== '' ? { dshVersion: config.dshVersion } : {}),
  })
  registerProbeTool(ctx, adapter)
}
