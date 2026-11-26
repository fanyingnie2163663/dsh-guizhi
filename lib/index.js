/**
 * Guizhi · host half.
 *
 * The plugin row inserted by cordis.patch.yml loads this module. It exports no
 * hard service dependency (inject = []): every host service is optional and
 * resolved defensively, so a host without webServer/tools loads the plugin with
 * a warning instead of failing the profile.
 *
 * What it mounts (Task 7; this is the only file allowed to import
 * @deepseek-ai/dsh-tools, D11):
 * - stow_probe (read-only host capability probe, kept from Task 0);
 * - the twelve /api/guizhi panel routes through webServer.register inside a
 *   scope.effect; the node http req/res adapter (JSON body cap, loopback /
 *   connection fence, status codes) lives in lib/http.js and the shared tool
 *   output contract in lib/tool-output.js;
 * - the nine stow_* tools through tools.register(defineTool(...)): thin shells
 *   over the lib/routes.js handlers (no duplicated business logic).
 *
 * Route paths are root-absolute because the host mounts them on its origin; the
 * browser half mirrors them document-relative (api/guizhi/...) so a sub-path
 * deployment still reaches them (docs/host-notes.md §6).
 *
 * Data root (D16, revised in fix round 1): dshHomePath('guizhi') service ->
 * profileContext.home -> $DSH_HOME -> ~/.dsh, resolved by lib/host.js
 * resolveDataRoot so the plugin and the adapter share one rule.
 *
 * Degradation policy: a missing service, a failed registration or an
 * unbuildable state layer is announced with a warning and skipped — never
 * silently and never by throwing into the profile boot.
 *
 * 真机验证 not-run（D5）：本任务没有把插件装进测试 profile、没有重启 DSH，
 * 也没有请求任何真实端点。面板三屏 / 路由可达性 / 工具注册的真实运行需要按
 * docs/host-notes.md §8 的手动步骤在测试 profile 中验证（见 task-7-report.md）。
 *
 * @module @fanyingnie/dsh-guizhi
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { withAttribution } from './attribution.js'
import { createHostAdapter, describeError, resolveDataRoot } from './host.js'
import { createHttpHandler } from './http.js'
import { probeHost } from './probe.js'
import { TOOL_SPECS, createRoutes, registerTools } from './routes.js'
import { createStore } from './store.js'
import { TOOL_OUTPUT } from './tool-output.js'

/** Cordis plugin name (the package specifier lives in cordis.patch.yml). */
export const name = 'dsh-guizhi'

/**
 * No mandatory dependency: webServer and tools are mounted through the optional
 * ctx.inject([...], cb) form, everything else through protected ctx.get.
 * inject stays empty so the cordis row needs no inject list.
 */
export const inject = []

/** Kept from Task 0: the read-only capability probe tool. */
const PROBE_TOOL_NAME = 'stow_probe'

/** @param {unknown} value */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Warn through the host logger, falling back to console: a degraded capability
 * is always announced, never silently dropped.
 * @param {*} ctx @param {string} message
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
 * Register the read-only stow_probe tool in a scope that injects tools.
 * @param {*} ctx @param {import('./host.js').HostAdapter} adapter
 */
function registerProbeTool(ctx, adapter) {
  if (typeof ctx?.inject !== 'function') {
    warn(ctx, 'ctx.inject 不可用：stow_probe 未注册（宿主不提供 tools 注入）')
    return
  }
  try {
    ctx.inject(['tools'], (scope) => {
      try {
        if (!scope?.tools || typeof scope.tools.register !== 'function') {
          warn(ctx, 'tools 服务不可用：stow_probe 未注册')
          return
        }
        scope.tools.register(defineTool({
          name: PROBE_TOOL_NAME,
          description: '探测当前 DSH 宿主能力：已注册工具数、插件数、技能数、会话工具事件来源是否可用、profile 路径与 DSH 版本。只读，返回 JSON。',
          parameters: {},
          output: TOOL_OUTPUT,
          isConcurrencySafe: () => true,
          async execute() {
            const result = await probeHost(adapter)
            return { text: JSON.stringify(result) }
          },
        }))
      } catch (error) {
        warn(ctx, '注册 ' + PROBE_TOOL_NAME + ' 失败：' + describeError(error))
      }
    })
  } catch (error) {
    warn(ctx, 'tools 注入失败：' + describeError(error))
  }
}

/**
 * Build one defineTool definition from a lib/routes.js shell.
 * @param {{ name: string, handler: (input?: unknown) => Promise<unknown> }} shell
 * @param {{ description: string, parameters: object, concurrencySafe?: boolean } | undefined} spec
 */
function buildToolDefinition(shell, spec) {
  return {
    name: shell.name,
    description: spec?.description ?? '归置（' + shell.name + '）',
    parameters: spec?.parameters ?? {},
    output: TOOL_OUTPUT,
    isConcurrencySafe: spec?.concurrencySafe === true ? () => true : () => false,
    async execute(args) {
      try {
        return { text: JSON.stringify(await shell.handler(args ?? {})) }
      } catch (error) {
        // A business failure is data for the agent (code/status/errors), not a
        // transport crash: degrade explicitly instead of throwing at the host.
        const payload = { ok: false, error: describeError(error) }
        if (typeof error?.status === 'number') payload.status = error.status
        if (isObject(error?.payload)) Object.assign(payload, error.payload)
        return { text: JSON.stringify(payload) }
      }
    },
  }
}

/**
 * Register the nine stow_* tools through the optional tools injection. One
 * failed tool registration only warns; the rest still mount.
 * @param {*} ctx @param {object} deps
 */
function mountTools(ctx, deps) {
  if (typeof ctx?.inject !== 'function') {
    warn(ctx, 'ctx.inject 不可用：stow_* 工具未注册')
    return
  }
  let shells
  try {
    shells = registerTools({ deps })
  } catch (error) {
    warn(ctx, '构建 stow_* 工具失败：' + describeError(error))
    return
  }
  const specByName = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]))
  try {
    ctx.inject(['tools'], (scope) => {
      try {
        if (!scope?.tools || typeof scope.tools.register !== 'function') {
          warn(ctx, 'tools 服务不可用：stow_* 工具未注册')
          return
        }
        for (const shell of shells) {
          try {
            scope.tools.register(defineTool(buildToolDefinition(shell, specByName.get(shell.name))))
          } catch (error) {
            warn(ctx, '注册 ' + shell.name + ' 失败：' + describeError(error))
          }
        }
      } catch (error) {
        warn(ctx, 'stow_* 工具注册失败：' + describeError(error))
      }
    })
  } catch (error) {
    warn(ctx, 'tools 注入失败：' + describeError(error))
  }
}

/**
 * Register the twelve panel routes on the host web server. The web server is
 * optional (a CLI session has none), so this goes through ctx.inject.
 * @param {*} ctx @param {object} deps
 */
function mountRoutes(ctx, deps) {
  if (typeof ctx?.inject !== 'function') {
    warn(ctx, 'ctx.inject 不可用：面板 HTTP 路由未注册')
    return
  }
  let routes
  try {
    routes = createRoutes({ deps })
  } catch (error) {
    warn(ctx, '构建面板路由失败：' + describeError(error))
    return
  }
  try {
    ctx.inject(['webServer'], (scope) => {
      try {
        if (!isObject(scope?.webServer) || typeof scope.webServer.register !== 'function') {
          warn(ctx, 'webServer 服务不可用：面板 HTTP 路由未注册')
          return
        }
        const mount = () => {
          const releases = []
          try {
            for (const route of routes) {
              releases.push(scope.webServer.register({ kind: 'exact', path: route.path, handler: createHttpHandler(ctx, route) }))
            }
          } catch (error) {
            // A partial mount must not leak registrations: release what this
            // attempt already registered before the caller warns (fix round 1).
            for (const release of releases.splice(0)) {
              try {
                release()
              } catch (inner) {
                warn(ctx, '回滚部分面板路由失败：' + describeError(inner))
              }
            }
            throw error
          }
          return () => {
            for (const release of releases.splice(0)) {
              try {
                release()
              } catch (error) {
                warn(ctx, '注销面板路由失败：' + describeError(error))
              }
            }
          }
        }
        if (typeof scope.effect === 'function') {
          scope.effect(mount, 'guizhi: panel routes')
        } else {
          warn(ctx, 'scope.effect 不可用：面板路由无法随插件卸载回收')
          mount()
        }
      } catch (error) {
        warn(ctx, '注册面板路由失败：' + describeError(error))
      }
    })
  } catch (error) {
    warn(ctx, 'webServer 注入失败：' + describeError(error))
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
  /** @type {{ host: object, store: object, home: string } | null} */
  let deps = null
  try {
    const home = resolveDataRoot(ctx)
    deps = { host: withAttribution(adapter, { profilePath: adapter.profilePath() }), store: createStore({ home }), home }
  } catch (error) {
    warn(ctx, '归置状态层构建失败，面板路由与 stow_* 工具降级为不注册：' + describeError(error))
    return
  }
  mountRoutes(ctx, deps)
  mountTools(ctx, deps)
}
