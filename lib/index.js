/**
 * Guizhi · host half.
 *
 * The plugin row inserted by cordis.patch.yml loads this module. It exports no
 * hard service dependency (`inject = []`): every host service is optional and
 * resolved defensively, so a host without webServer / tools loads the plugin
 * with a warning instead of failing the profile.
 *
 * Task 0 delivers the scaffold plus the read-only capability probe:
 * - `stow_probe` tool: returns the HostAdapter probe as JSON;
 * - `GET /api/guizhi/health`: loopback-only JSON probe for the client half and
 *   manual verification without a session.
 *
 * @module @fanyingnie/dsh-guizhi
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHostAdapter, describeError } from './host.js'
import { probeHost } from './probe.js'

/** Cordis plugin name (the package specifier lives in cordis.patch.yml). */
export const name = 'dsh-guizhi'

/**
 * No mandatory dependency: tools / webServer are mounted through the optional
 * `ctx.inject([...], cb)` form, everything else through protected `ctx.get`.
 * `inject` stays empty so the row needs no `inject` list in cordis.patch.yml.
 */
export const inject = []

const PROBE_TOOL_NAME = 'stow_probe'
const HEALTH_ROUTE_PATH = '/api/guizhi/health'

/** JSON response headers: never cached, never referrer-leaking. */
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
})

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
 * The client half talks to this origin, so loopback is the normal case.
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(response, status, body) {
  if (response.writableEnded) return
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
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
 * Mount `GET /api/guizhi/health` when the host exposes a web server. The route
 * is loopback-only and read-only; it answers the same probe JSON as stow_probe.
 * @param {*} ctx
 * @param {import('./host.js').HostAdapter} adapter
 */
function registerHealthRoute(ctx, adapter) {
  if (typeof ctx?.inject !== 'function') {
    warn(ctx, 'ctx.inject 不可用：健康检查路由未挂载（宿主不提供 webServer 注入）')
    return
  }
  try {
    ctx.inject(['webServer'], (scope) => {
      try {
        if (!scope.webServer || typeof scope.webServer.register !== 'function') {
          warn(ctx, 'webServer 服务不可用：健康检查路由未挂载')
          return
        }
        if (typeof scope.effect !== 'function') {
          warn(ctx, 'scope.effect 不可用：无法登记路由清理，健康检查路由未挂载')
          return
        }
        scope.effect(
          () => scope.webServer.register({
            kind: 'exact',
            path: HEALTH_ROUTE_PATH,
            async handler(request, response) {
              if (!isLoopbackRequest(request)) {
                writeJson(response, 403, { error: 'forbidden: loopback-only' })
                return
              }
              if (request.method !== 'GET') {
                writeJson(response, 405, { error: `method not allowed: ${request.method ?? ''}` })
                return
              }
              writeJson(response, 200, await probeHost(adapter))
            },
          }),
          'guizhi: health route',
        )
        try {
          ctx.logger?.info?.(`guizhi: health route mounted ${HEALTH_ROUTE_PATH}`)
        } catch {
          // Logging must never break plugin load.
        }
      } catch (error) {
        warn(ctx, `挂载健康检查路由失败：${describeError(error)}`)
      }
    })
  } catch (error) {
    warn(ctx, `webServer 注入失败：${describeError(error)}`)
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
  registerHealthRoute(ctx, adapter)
}
