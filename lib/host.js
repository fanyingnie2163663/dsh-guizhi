/**
 * Guizhi host adapter: the read-only seam between this plugin and DSH services.
 *
 * Every capability is resolved defensively: a missing service or a throwing
 * call degrades to an empty value and appends a warning; nothing here throws
 * into the plugin load or a tool call. The five service names used below are
 * the host contracts recorded in docs/host-notes.md:
 *
 * - `tools`          — global tool registry view (name/description only)
 * - `skills`         — skill catalog summaries
 * - `sessionQuery`   — session corpus + full event logs (tool/call records)
 * - `profileContext` — provided by the profile boot ({ name, dir, patchPath, home })
 * - `pluginInventory`— Loader plugin entries (fallback for the plugin list)
 *
 * @module @fanyingnie/dsh-guizhi/host
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { isSessionMissingError } from './dispatch.js'
import { scanSkillRoots } from './skillscan.js'
import { createToolFaceController } from './toolface.js'

/** Environment variables that may carry the running harness version. */
const DSH_VERSION_ENV_KEYS = ['DSH_CLIENT_VERSION', 'DSH_VERSION']
/** package.json names that identify the harness installation while walking up. */
const DSH_PACKAGE_NAMES = new Set(['@deepseek-ai/dsh', 'dsh', 'dsh-cli'])
/** How many parent directories the version lookup walks before giving up. */
const VERSION_LOOKUP_DEPTH = 8
/** Only plain concrete versions are taken from a dependency spec; ranges are not versions. */
const CONCRETE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * @typedef {object} ToolFact
 * @property {string} name
 * @property {string} description
 * @property {string} [owner] Reserved for later static attribution (no host API exposes it).
 */

/**
 * @typedef {object} PluginFact
 * @property {string} name
 * @property {string} [version]
 * @property {'patch' | 'npm'} source
 */

/**
 * @typedef {object} SkillFact
 * @property {string} name
 * @property {string} [source]
 */

/**
 * @typedef {object} ToolCallEvent
 * @property {string} tool
 * @property {string} at ISO-8601 timestamp derived from the session event time.
 * @property {string} sessionId
 */

/**
 * @typedef {object} HostAdapter
 * @property {() => Promise<ToolFact[]>} listTools
 * @property {() => Promise<PluginFact[]>} listPlugins
 * @property {() => Promise<SkillFact[]>} listSkills Host catalog merged with a
 *   read-only disk scan of the user/project skill roots (host rows win by name).
 * @property {(sinceISO?: string) => AsyncIterable<ToolCallEvent> | null} sessionEvents
 * @property {() => string} profilePath
 * @property {() => string} dshVersion
 * @property {() => { available: boolean, reason?: string }} dispatchSupport Whether a background
 *   dispatch can run (sessionController create/prompt + sessionQuery readSession).
 * @property {(options?: { sessionId?: string }) => Promise<string>} createDispatchSession Create the
 *   dedicated background Session, optionally with a pre-generated id.
 * @property {(input: { sessionId: string, requestId: string, text: string }) => Promise<void>} promptDispatchSession
 *   Admit one prompt into the background Session (throws a readable Error on failure).
 * @property {(sessionId: string) => Promise<Array<object> | null>} readDispatchEvents Read the
 *   Session event log for status derivation; null when unreadable.
 * @property {() => { available: boolean, reason?: string }} toolFaceSupport Whether this host can
 *   restrict a worker Agent's tool surface (agent lifecycle hooks + tools.view/restrict).
 * @property {(sessionId: string, allowedTools: string[]) => boolean} prepareWorkerToolFace Record
 *   the allowlist a pre-generated worker Session should receive.
 * @property {(sessionId: string) => void} forgetWorkerToolFace Drop a planned allowlist.
 * @property {(sessionId: string) => object | null} takeWorkerToolFaceReport Take the
 *   report recorded when the worker Agent was created: the actual visible tool
 *   names after restrict plus allowed/skipped/leaked and a failure reason; null
 *   when this host recorded none (unknown Session, hook never ran, old host).
 * @property {() => boolean} refreshSkillsCatalog Ask the host skills service to
 *   invalidate its catalog cache after this plugin wrote/deleted
 *   <$DSH_HOME>/skills with node:fs; false when the host has no such API or the
 *   call failed (warned once per adapter).
 * @property {string[]} warnings Read-only snapshot of the warnings collected so
 *   far (a fresh array on every read, never the internal buffer).
 * @property {() => string[]} takeWarnings Return this batch's warnings and reset
 *   the internal buffer; probeHost drains it so repeated probes never accumulate.
 */

/** Describe an unknown error without a stack. @param {unknown} error */
export function describeError(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error)
  return text === '' ? 'unknown error' : text
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one optional host service without ever throwing. Shared with
 * lib/index.js so the plugin wiring resolves services exactly like the adapter.
 * Property access on an un-injected cordis service throws, so use `get` and
 * try both the non-strict and the strict form (mirrors the installed plugins).
 * @param {*} ctx
 * @param {string} name
 */
export function tryGet(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return undefined
  try {
    const viaNonStrict = ctx.get(name, false)
    if (viaNonStrict !== undefined) return viaNonStrict
  } catch {
    // Fall through to the strict form.
  }
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Sort facts by name for a stable probe output. @param {{name: string}} a @param {{name: string}} b */
function byName(a, b) {
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

/**
 * Detect the running harness version: explicit env first, then walk up from the
 * process entry points to the `@deepseek-ai/dsh` package.json, else 'unknown'.
 * @param {{ env?: Record<string, string | undefined>, argv?: string[], execPath?: string }} [options]
 * @returns {string}
 */
export function detectDshVersion(options = {}) {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv
  const execPath = options.execPath ?? process.execPath
  for (const key of DSH_VERSION_ENV_KEYS) {
    const value = env?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  for (const entry of [argv?.[1], argv?.[0], execPath]) {
    const found = versionFromAncestors(entry)
    if (found !== '') return found
  }
  return 'unknown'
}

/** @param {unknown} startPath */
function versionFromAncestors(startPath) {
  if (typeof startPath !== 'string' || startPath === '') return ''
  let dir = dirname(startPath)
  for (let depth = 0; depth < VERSION_LOOKUP_DEPTH; depth += 1) {
    const candidate = join(dir, 'package.json')
    try {
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
        const name = typeof parsed?.name === 'string' ? parsed.name : ''
        const version = typeof parsed?.version === 'string' ? parsed.version : ''
        if (DSH_PACKAGE_NAMES.has(name) && version !== '') return version
      }
    } catch {
      // A malformed package.json on the way up is not worth failing the lookup.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/** Read `--profile <name>` from a CLI argv. @param {unknown} argv @returns {string} */
export function detectProfileName(argv) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--profile') {
      const next = args[index + 1]
      if (next !== undefined && next !== '' && !next.startsWith('-')) return next
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length)
      if (value !== '') return value
    }
  }
  return ''
}

/**
 * Resolve the DeepSeek Harness home directory: an explicit override wins, then
 * $DSH_HOME, then the documented default ~/.dsh (docs/host-notes.md 其他关键事实).
 * Shared by resolveProfilePath and (Task 7 fix round 1, D16 revision)
 * resolveDataRoot so both use the same rule.
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string}
 */
export function resolveDshHome(options = {}) {
  if (typeof options.home === 'string' && options.home.trim() !== '') return options.home
  const env = options.env ?? process.env
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') return env.DSH_HOME
  return join(homedir(), '.dsh')
}

/**
 * Resolve the user-level agents home (~/.agents) that carries cross-harness
 * user skills. The host's dsh-home-paths helper is not an importable
 * dependency of this plugin (package.json declares only the
 * @deepseek-ai/dsh-tools peer), so its documented default location is used;
 * an explicit options.agentsHome wins (tests inject a temp dir).
 * @param {{ agentsHome?: string }} [options]
 * @returns {string}
 */
export function resolveAgentsHome(options = {}) {
  if (typeof options.agentsHome === 'string' && options.agentsHome.trim() !== '') return options.agentsHome
  return join(homedir(), '.agents')
}

/**
 * Read-only disk roots whose skills are merged into the host skills catalog
 * (真机缺陷 B). Only roots the host documents are scanned; other custom roots
 * are unknown and stay host-only. Order is the merge priority: a later root
 * never replaces an earlier discovery.
 *
 * dshHome comes from profileContext.home when present, else resolveDshHome
 * (explicit options.home -> $DSH_HOME -> ~/.dsh). Project roots are added only
 * when profileContext.cwd exists. options.skillRoots is an explicit test/embed
 * override that disables the computed roots entirely.
 *
 * @param {*} ctx
 * @param {{ home?: string, agentsHome?: string, env?: Record<string, string | undefined>, skillRoots?: { path: string, source?: string }[] }} [options]
 * @returns {{ path: string, source?: string }[]}
 */
export function resolveSkillRoots(ctx, options = {}) {
  if (Array.isArray(options.skillRoots)) {
    return options.skillRoots.filter((root) => isRecord(root) && typeof root.path === 'string' && root.path !== '')
  }
  const profileContext = tryGet(ctx, 'profileContext')
  const context = isRecord(profileContext) ? profileContext : undefined
  const dshHome =
    context !== undefined && typeof context.home === 'string' && context.home !== ''
      ? context.home
      : resolveDshHome(options)
  /** @type {{ path: string, source?: string }[]} */
  const roots = [
    { path: join(dshHome, 'skills'), source: 'user-dsh' },
    { path: join(resolveAgentsHome(options), 'skills'), source: 'user-agents' },
  ]
  const cwd = context !== undefined && typeof context.cwd === 'string' && context.cwd !== '' ? context.cwd : undefined
  if (cwd !== undefined) {
    roots.push({ path: join(cwd, '.dsh', 'skills'), source: 'project-dsh' })
    roots.push({ path: join(cwd, '.agents', 'skills'), source: 'project-agents' })
  }
  return roots
}

/**
 * Resolve Guizhi's data root (D16 revision, Task 7 fix round 1). Precedence:
 * 1. the host `dshHomePath('guizhi')` service when it exists;
 * 2. `profileContext.home` (the DSH home the profile boot provides);
 * 3. $DSH_HOME (or an explicit options.home) -> <home>/guizhi;
 * 4. ~/.dsh/guizhi.
 * Every step degrades to the next when the service is missing, throws or
 * returns an empty path, so a degraded host still gets a usable data root.
 * @param {*} ctx
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string}
 */
export function resolveDataRoot(ctx, options = {}) {
  const homePath = tryGet(ctx, 'dshHomePath')
  if (typeof homePath === 'function') {
    try {
      const value = homePath('guizhi')
      if (typeof value === 'string' && value.trim() !== '') return value
    } catch {
      // A throwing host helper degrades to the next source.
    }
  }
  const profileContext = tryGet(ctx, 'profileContext')
  if (isRecord(profileContext) && typeof profileContext.home === 'string' && profileContext.home !== '') {
    return join(profileContext.home, 'guizhi')
  }
  return join(resolveDshHome(options), 'guizhi')
}

/**
 * Resolve the profile directory in use. `profileContext` is authoritative when
 * present; the config override and env/argv fallbacks keep the adapter testable
 * off a live host. Empty string means "not resolvable".
 * @param {*} ctx
 * @param {{ profilePath?: string, profileName?: string, env?: Record<string, string | undefined>, argv?: string[], home?: string }} options
 * @returns {string}
 */
export function resolveProfilePath(ctx, options = {}) {
  if (typeof options.profilePath === 'string' && options.profilePath !== '') return options.profilePath
  const profileContext = tryGet(ctx, 'profileContext')
  if (profileContext && typeof profileContext.dir === 'string' && profileContext.dir !== '') return profileContext.dir
  const env = options.env ?? process.env
  const name =
    typeof options.profileName === 'string' && options.profileName !== ''
      ? options.profileName
      : typeof env?.DSH_PROFILE === 'string' && env.DSH_PROFILE !== ''
        ? env.DSH_PROFILE
        : detectProfileName(options.argv ?? process.argv)
  if (name === '') return ''
  return join(resolveDshHome(options), 'profiles', name)
}

/**
 * A concrete version from a package.json dependency spec, or undefined.
 * @param {unknown} spec
 */
function concreteVersion(spec) {
  return typeof spec === 'string' && CONCRETE_VERSION.test(spec) ? spec : undefined
}

/** @param {string} profileDir @param {string} name */
async function installedPluginVersion(profileDir, name) {
  try {
    const raw = await readFile(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.version === 'string' && parsed.version !== '' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Collect the plugin names a cordis patch document declares: a row's own
 * `name`, or the `name` of every row inside an `insert` list.
 * @param {unknown} document
 * @returns {string[]}
 */
export function patchPluginNames(document) {
  const names = new Set()
  const rows = Array.isArray(document) ? document : isRecord(document) ? [document] : []
  for (const row of rows) {
    if (!isRecord(row)) continue
    if (typeof row.name === 'string' && row.name !== '') names.add(row.name)
    const inserts = Array.isArray(row.insert) ? row.insert : []
    for (const inserted of inserts) {
      if (isRecord(inserted) && typeof inserted.name === 'string' && inserted.name !== '') names.add(inserted.name)
    }
  }
  return [...names]
}

/**
 * @param {string} profileDir
 * @param {Map<string, PluginFact>} merged
 * @param {(message: string) => void} warn
 * @returns {Promise<boolean>} whether package.json was readable
 */
async function readProfileDependencies(profileDir, merged, warn) {
  try {
    const parsed = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const dependencies = isRecord(parsed?.dependencies) ? parsed.dependencies : {}
    const devDependencies = isRecord(parsed?.devDependencies) ? parsed.devDependencies : {}
    for (const [name, spec] of Object.entries({ ...dependencies, ...devDependencies })) {
      if (typeof name !== 'string' || name === '') continue
      const version = (await installedPluginVersion(profileDir, name)) ?? concreteVersion(spec)
      merged.set(name, version === undefined ? { name, source: 'npm' } : { name, version, source: 'npm' })
    }
    return true
  } catch (error) {
    warn('读取 profile package.json 失败：' + describeError(error))
    return false
  }
}

/**
 * @param {string} profileDir
 * @param {Map<string, PluginFact>} merged
 * @param {(message: string) => void} warn
 * @returns {Promise<boolean>} whether cordis.patch.yml was readable
 */
async function readPatchRows(profileDir, merged, warn) {
  try {
    const document = parseYaml(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'))
    for (const name of patchPluginNames(document)) {
      const existing = merged.get(name)
      merged.set(name, existing === undefined ? { name, source: 'patch' } : { ...existing, source: 'patch' })
    }
    return true
  } catch (error) {
    warn('读取 profile cordis.patch.yml 失败：' + describeError(error))
    return false
  }
}

/**
 * @param {unknown} entry
 * @returns {PluginFact | undefined}
 */
function pluginFactFromInventory(entry) {
  if (!isRecord(entry) || typeof entry.moduleName !== 'string' || entry.moduleName === '') return undefined
  const version = isRecord(entry.meta) && typeof entry.meta.version === 'string' && entry.meta.version !== '' ? entry.meta.version : undefined
  return version === undefined ? { name: entry.moduleName, source: 'npm' } : { name: entry.moduleName, version, source: 'npm' }
}

/** @param {unknown} sinceISO @param {(message: string) => void} warn @returns {number | undefined} */
function parseSince(sinceISO, warn) {
  if (sinceISO === undefined || sinceISO === null || sinceISO === '') return undefined
  const time = Date.parse(String(sinceISO))
  if (Number.isNaN(time)) {
    warn(`sessionEvents 忽略无法解析的 sinceISO：${String(sinceISO)}`)
    return undefined
  }
  return time
}

/**
 * Header createdAt of one listSessions record as epoch milliseconds.
 * @param {unknown} record
 * @returns {number | undefined} undefined when the header carries no usable createdAt
 */
function recordCreatedAt(record) {
  const header = isRecord(record) && isRecord(record.header) ? record.header : null
  if (header === null || typeof header.createdAt !== 'string' || header.createdAt === '') return undefined
  const time = Date.parse(header.createdAt)
  return Number.isNaN(time) ? undefined : time
}

/**
 * Create the host adapter for one plugin load.
 *
 * The fixed interface is listTools / listPlugins / listSkills / sessionEvents /
 * profilePath / dshVersion. `warnings` / `takeWarnings()` are a documented
 * additive diagnostics pair: `warnings` is a read-only snapshot, and
 * `takeWarnings()` drains the current batch so probeHost never accumulates or
 * shares mutable state between probes.
 *
 * @param {*} ctx cordis plugin context
 * @param {{ profilePath?: string, profileName?: string, dshVersion?: string, env?: Record<string, string | undefined>, argv?: string[], execPath?: string, home?: string, logger?: { warn?: (message: string) => void } }} [options]
 * @returns {HostAdapter}
 */
export function createHostAdapter(ctx, options = {}) {
  /** @type {string[]} */
  const warnings = []
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv
  const execPath = options.execPath ?? process.execPath
  const logger = options.logger ?? (ctx && isRecord(ctx) ? ctx.logger : undefined)

  /** @param {string} message */
  const warn = (message) => {
    const text = String(message)
    warnings.push(text)
    try {
      if (logger && typeof logger.warn === 'function') logger.warn('[guizhi] ' + text)
      else if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn('[guizhi] ' + text)
    } catch {
      // A throwing logger must not break the probe.
    }
  }

  /**
   * S3 tool-face controller: pending allowlists keyed by pre-generated Session
   * id, plus the Agent-scoped restrict() disposers. It is registered on the
   * Agent lifecycle below; every failure path degrades to a warning so a
   * dispatch can always run as a soft-constraint worker.
   */
  const toolFaceController = createToolFaceController({
    getTools: () => tryGet(ctx, 'tools'),
    warn,
  })
  /** Tool-face warnings are emitted once per adapter, not every dispatch poll. */
  const toolFaceWarned = new Set()
  const warnToolFace = (message) => {
    const text = String(message)
    if (toolFaceWarned.has(text)) return
    toolFaceWarned.add(text)
    warn(text)
  }
  /** True only after both Agent lifecycle listeners registered. */
  let toolFaceHooksRegistered = false
  if (ctx !== null && typeof ctx === 'object' && typeof ctx.on === 'function') {
    try {
      ctx.on('agent/created', (event) => {
        try {
          toolFaceController.onCreated(event !== null && typeof event === 'object' ? event.agent : undefined)
        } catch (error) {
          warn('工具面诊断应用失败：' + describeError(error))
        }
      })
      ctx.on('agent/disposed', (event) => {
        try {
          toolFaceController.onDisposed(event !== null && typeof event === 'object' ? event.agent : undefined)
        } catch (error) {
          warn('工具面诊断清理失败：' + describeError(error))
        }
      })
      toolFaceHooksRegistered = true
    } catch (error) {
      warn('注册 agent 生命周期钩子失败：' + describeError(error) + '；工具面诊断不可用')
    }
  }
  if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
    try {
      ctx.effect(
        () => () => {
          try {
            toolFaceController.dispose()
          } catch (error) {
            warn('工具面诊断清理失败：' + describeError(error))
          }
        },
        'guizhi: tool face restrictions',
      )
    } catch (error) {
      warn('注册工具面诊断清理失败：' + describeError(error))
    }
  }

  /** @type {string | undefined} */
  let cachedProfilePath
  /** @type {string | undefined} */
  let cachedDshVersion

  /** @returns {string} */
  const profilePath = () => {
    if (cachedProfilePath === undefined) cachedProfilePath = resolveProfilePath(ctx, options)
    return cachedProfilePath
  }

  /** @returns {string} */
  const dshVersion = () => {
    if (cachedDshVersion === undefined) {
      cachedDshVersion =
        typeof options.dshVersion === 'string' && options.dshVersion !== ''
          ? options.dshVersion
          : detectDshVersion({ env, argv, execPath })
    }
    return cachedDshVersion
  }

  /** @returns {Promise<ToolFact[]>} */
  const listTools = async () => {
    const tools = tryGet(ctx, 'tools')
    if (tools === undefined || typeof tools.view !== 'function') {
      warn('tools 服务不可用：工具清单为空')
      return []
    }
    let view
    try {
      view = tools.view(undefined)
    } catch (error) {
      warn('tools.view 失败：' + describeError(error))
      return []
    }
    const visible = view?.visible
    /** @type {Array<[unknown, unknown]>} */
    let entries
    if (visible instanceof Map) entries = [...visible.entries()]
    else if (isRecord(visible)) entries = Object.entries(visible)
    else {
      warn('tools.view 返回结构异常：工具清单为空')
      return []
    }
    return entries
      .map(([name, definition]) => ({
        name: String(name),
        description: isRecord(definition) && typeof definition.description === 'string' ? definition.description : '',
      }))
      .sort(byName)
  }

  /** @returns {Promise<PluginFact[]>} */
  const listPlugins = async () => {
    const profileDir = profilePath()
    /** @type {Map<string, PluginFact>} */
    const merged = new Map()
    if (profileDir === '') {
      warn('profile 路径不可用：跳过 profile 文件，尝试 pluginInventory 服务')
    } else {
      const dependenciesRead = await readProfileDependencies(profileDir, merged, warn)
      const patchRead = await readPatchRows(profileDir, merged, warn)
      if (merged.size > 0) return [...merged.values()].sort(byName)
      warn(dependenciesRead || patchRead ? 'profile 文件里没有插件行：尝试 pluginInventory 服务' : 'profile 文件不可读：尝试 pluginInventory 服务')
    }
    const inventory = tryGet(ctx, 'pluginInventory')
    if (inventory !== undefined && typeof inventory.list === 'function') {
      try {
        const snapshot = await inventory.list()
        const entries = isRecord(snapshot) && Array.isArray(snapshot.entries) ? snapshot.entries : []
        const facts = entries.map(pluginFactFromInventory).filter((fact) => fact !== undefined)
        if (facts.length > 0) return facts.sort(byName)
      } catch (error) {
        warn('pluginInventory.list 失败：' + describeError(error))
      }
    } else {
      warn('pluginInventory 服务不可用：插件清单为空')
    }
    return []
  }

  /**
   * Host skills.list result merged with a read-only disk scan (真机缺陷 B).
   *
   * The host service is authoritative: its rows win by name. Disk discoveries
   * only fill names the host did not report, in root order (user-dsh,
   * user-agents, project-dsh, project-agents). A missing/throwing service is a
   * warning, not an empty list: the disk scan still returns what it finds. An
   * unreadable root or skill file never throws out of this method.
   * @returns {Promise<SkillFact[]>}
   */
  const listSkills = async () => {
    /** @type {SkillFact[]} */
    const hostSkills = []
    const skills = tryGet(ctx, 'skills')
    if (skills === undefined || typeof skills.list !== 'function') {
      warn('skills 服务不可用：技能清单改由磁盘目录补扫')
    } else {
      let summaries
      try {
        summaries = await skills.list({})
      } catch (error) {
        warn('skills.list 失败：' + describeError(error) + '；技能清单改由磁盘目录补扫')
      }
      const list = Array.isArray(summaries) ? summaries : []
      for (const summary of list) {
        const name = isRecord(summary) && typeof summary.name === 'string' ? summary.name : ''
        if (name === '') continue
        const source =
          isRecord(summary) && typeof summary.source === 'string' && summary.source !== ''
            ? summary.source
            : isRecord(summary) && typeof summary.provider === 'string'
              ? summary.provider
              : undefined
        hostSkills.push(source === undefined ? { name } : { name, source })
      }
    }
    /** @type {SkillFact[]} */
    let diskSkills = []
    try {
      diskSkills = await scanSkillRoots(resolveSkillRoots(ctx, options))
    } catch (error) {
      warn('扫描磁盘技能目录失败：' + describeError(error))
    }
    const merged = hostSkills.slice()
    const seen = new Set(merged.map((skill) => skill.name))
    for (const skill of diskSkills) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      merged.push(skill)
    }
    return merged.sort(byName)
  }

  /**
   * Stream tool/call events as { tool, at, sessionId }.
   *
   * The full event log is required: sessionQuery.listEvents returns lightweight
   * records without `data` (see docs/host-notes.md ④), so readSession is the
   * source of the tool name.
   *
   * F5: when a sinceISO window is given, listSessions records are pre-filtered by
   * `header.createdAt` before any readSession: a session created outside the
   * window cannot contain in-window tool calls, so its log is not read at all.
   * A record without a usable createdAt is kept conservatively and the exact
   * per-event `event.time >= since` check below still decides.
   * @param {string} [sinceISO]
   * @returns {AsyncIterable<ToolCallEvent> | null}
   */
  const sessionEvents = (sinceISO) => {
    const sessionQuery = tryGet(ctx, 'sessionQuery')
    if (
      sessionQuery === undefined ||
      typeof sessionQuery.listSessions !== 'function' ||
      typeof sessionQuery.readSession !== 'function'
    ) {
      warn('sessionQuery 服务不可用：会话工具事件来源为空')
      return null
    }
    const since = parseSince(sinceISO, warn)
    /** @returns {AsyncGenerator<ToolCallEvent, void, void>} */
    async function* iterate() {
      let records
      try {
        records = await sessionQuery.listSessions()
      } catch (error) {
        warn('sessionQuery.listSessions 失败：' + describeError(error))
        return
      }
      for (const record of Array.isArray(records) ? records : []) {
        const sessionId = isRecord(record) && isRecord(record.header) && typeof record.header.id === 'string' ? record.header.id : ''
        if (sessionId === '') continue
        // F5 window push-down: do not read a whole session log that started
        // before the window. Missing createdAt keeps the conservative old path.
        if (since !== undefined) {
          const createdAt = recordCreatedAt(record)
          if (createdAt !== undefined && createdAt < since) continue
        }
        let loaded
        try {
          loaded = await sessionQuery.readSession(sessionId)
        } catch (error) {
          warn(`sessionQuery.readSession(${sessionId}) 失败：${describeError(error)}`)
          continue
        }
        const events = isRecord(loaded) && Array.isArray(loaded.events) ? loaded.events : []
        for (const event of events) {
          if (!isRecord(event) || event.type !== 'tool/call') continue
          const time = typeof event.time === 'number' ? event.time : Number.NaN
          if (!Number.isFinite(time)) continue
          if (since !== undefined && time < since) continue
          const tool = isRecord(event.data) && typeof event.data.name === 'string' ? event.data.name : ''
          if (tool === '') continue
          yield { tool, at: new Date(time).toISOString(), sessionId }
        }
      }
    }
    return iterate()
  }

  /**
   * Whether the host can run a background dispatch.
   *
   * Both halves of the dispatch contract are required: sessionController
   * (create/prompt) admits the task and sessionQuery (readSession) derives its
   * state from the Session event log. A missing service is a warning, not a throw.
   * @returns {{ available: boolean, reason?: string }}
   */
  /** Dispatch status warnings: each message is reported once, not every 3s poll. */
  const dispatchWarned = new Set()
  const warnDispatch = (message) => {
    const text = String(message)
    if (dispatchWarned.has(text)) return
    dispatchWarned.add(text)
    warn(text)
  }

  const dispatchSupport = () => {
    const controller = tryGet(ctx, 'sessionController')
    const query = tryGet(ctx, 'sessionQuery')
    const missing = []
    if (controller === undefined || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') missing.push('sessionController')
    if (query === undefined || typeof query.readSession !== 'function') missing.push('sessionQuery')
    if (missing.length > 0) {
      const reason = '当前宿主缺少后台派单所需服务：' + missing.join('、')
      warnDispatch(reason)
      return { available: false, reason }
    }
    return { available: true }
  }

  /** @returns {object} the sessionController service; throws a readable Error when unusable. */
  const requireDispatchController = () => {
    const controller = tryGet(ctx, 'sessionController')
    if (controller === undefined || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
      throw new Error('后台派单需要的 sessionController 服务不可用')
    }
    return controller
  }

  /**
   * Create the dedicated background Session.
   * @param {{ sessionId?: string }} [options] optional pre-generated id; passing
   *   it lets the tool-face controller match the Agent created for this Session.
   * @returns {Promise<string>} the new Session id.
   */
  const createDispatchSession = async (options = {}) => {
    const controller = requireDispatchController()
    const source = isRecord(options) ? options : {}
    const request = typeof source.sessionId === 'string' && source.sessionId !== '' ? { sessionId: source.sessionId } : {}
    let created
    try {
      created = await controller.create(request)
    } catch (error) {
      throw new Error('创建后台会话失败：' + describeError(error))
    }
    const sessionId = isRecord(created) && typeof created.sessionId === 'string' ? created.sessionId : ''
    if (sessionId === '') throw new Error('创建后台会话失败：宿主没有返回 sessionId')
    return sessionId
  }

  /**
   * Admit one prompt into the background Session.
   * @param {{ sessionId: string, requestId: string, text: string }} input
   * @returns {Promise<void>}
   */
  const promptDispatchSession = async ({ sessionId, requestId, text }) => {
    const controller = requireDispatchController()
    try {
      await controller.prompt(
        { sessionId, requestId, content: [{ type: 'text', text }], mode: 'queue' },
        new AbortController().signal,
      )
    } catch (error) {
      if (isSessionMissingError(error)) {
        const missing = new Error('后台会话不存在：' + describeError(error))
        missing.code = 'DISPATCH_SESSION_MISSING'
        throw missing
      }
      throw new Error('投递后台任务失败：' + describeError(error))
    }
  }

  /**
   * Read the background Session event log for the dispatch state reducer.
   * @param {string} sessionId
   * @returns {Promise<{ status: 'events', events: Array<object> } | { status: 'missing' } | { status: 'unreadable', error?: string }>}
   */
  const readDispatchEvents = async (sessionId) => {
    const query = tryGet(ctx, 'sessionQuery')
    if (query === undefined || typeof query.readSession !== 'function') {
      warnDispatch('读取后台会话不可用：sessionQuery.readSession 缺失')
      return { status: 'unreadable', error: 'sessionQuery 服务不可用' }
    }
    try {
      const loaded = await query.readSession(sessionId)
      return isRecord(loaded) && Array.isArray(loaded.events)
        ? { status: 'events', events: loaded.events }
        : { status: 'unreadable', error: 'readSession 返回结构异常' }
    } catch (error) {
      if (isSessionMissingError(error)) return { status: 'missing' }
      warnDispatch(`读取后台会话 ${sessionId} 失败：` + describeError(error))
      return { status: 'unreadable', error: describeError(error) }
    }
  }

  /**
   * Whether this host exposes what is needed to attempt a worker-Agent
   * tool-face restrict() and report the resulting diagnostics.
   *
   * The Agent-scoped `restrict` is only reachable from an Agent, so support is
   * decided from what is observable while the plugin loads: the agent lifecycle
   * hooks, the tools service view, and a view that exposes restrictableNames.
   * Every missing piece is a warning-only false, never a throw.
   * @returns {{ available: boolean, reason?: string }}
   */
  const toolFaceSupport = () => {
    const missing = []
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') missing.push('ctx.on（agent 生命周期钩子）')
    else if (!toolFaceHooksRegistered) missing.push('agent 生命周期钩子（ctx.on 注册失败）')
    const tools = tryGet(ctx, 'tools')
    if (tools === undefined || typeof tools.view !== 'function') missing.push('tools.view')
    if (missing.length > 0) {
      return { available: false, reason: '当前宿主缺少工具面诊断所需能力：' + missing.join('、') }
    }
    let view
    try {
      view = tools.view(undefined)
    } catch (error) {
      return { available: false, reason: '当前宿主工具视图不可读：' + describeError(error) }
    }
    if (!isRecord(view) || view.restrictableNames === undefined) {
      return { available: false, reason: '当前宿主工具视图没有 restrictableNames，无法准备工具面诊断' }
    }
    return { available: true }
  }

  /**
   * Record the allowlist the next worker Session should receive. Must be called
   * with the pre-generated session id BEFORE sessionController.create, so the
   * agent/created hook can match the Agent to this dispatch.
   * @param {string} sessionId @param {string[]} allowedTools
   * @returns {boolean} whether an allowlist was recorded.
   */
  const prepareWorkerToolFace = (sessionId, allowedTools) => {
    const support = toolFaceSupport()
    if (!support.available) {
      warnToolFace((support.reason ?? '当前宿主不支持工具面诊断') + '；本次按软约束派发 worker')
      return false
    }
    const planned = toolFaceController.plan(sessionId, allowedTools)
    if (!planned) warnToolFace('工具面诊断未准备：sessionId 或 allowlist 无效；本次按软约束派发 worker')
    return planned
  }

  /**
   * Drop a planned allowlist when the host does not adopt the pre-generated id
   * (or the dispatch fails before the Session exists).
   * @param {string} sessionId
   */
  const forgetWorkerToolFace = (sessionId) => {
    toolFaceController.forget(sessionId)
  }

  /**
   * Take the tool-face report recorded for one worker Session: the actual visible
   * tool names after restrict (真机验收证据), plus allowed/skipped/leaked and a
   * reason for the soft-constraint branches. One-shot: the report is deleted.
   * @param {string} sessionId
   * @returns {object | null} null when no report was recorded.
   */
  const takeWorkerToolFaceReport = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    try {
      return toolFaceController.takeReport(sessionId)
    } catch (error) {
      warn('读取 worker 实际工具面报告失败：' + describeError(error))
      return null
    }
  }

  /**
   * Ask the host skills service to drop its cached catalog (真机缺陷 A).
   *
   * apply/rollback write or delete <$DSH_HOME>/skills/<stow-…>/SKILL.md with
   * node:fs, which the host never observes as its own fs write; without this
   * invalidation stow_scan and a new session's available skills keep the stale
   * list until an unrelated fs observation happens.
   *
   * Degrades to false: a missing service/method is a normal older-host
   * degradation (silent), while a throwing invalidateCache is warned once per
   * adapter and never escapes into a tool route.
   * @returns {boolean} whether a cache invalidation was actually applied.
   */
  let skillsRefreshWarned = false
  const warnSkillsRefreshFailure = (error) => {
    if (skillsRefreshWarned) return
    skillsRefreshWarned = true
    warn('刷新技能缓存失败：' + describeError(error) + '；stow_scan 与新会话可能仍显示旧技能列表')
  }
  const refreshSkillsCatalog = () => {
    const skills = tryGet(ctx, 'skills')
    if (skills === undefined || typeof skills.invalidateCache !== 'function') return false
    try {
      const pending = skills.invalidateCache()
      // Defensive: a host may expose an async invalidation. Never leave its
      // rejection unhandled, but do not block the tool route on the cache.
      if (pending !== null && pending !== undefined && typeof pending.catch === 'function') pending.catch(warnSkillsRefreshFailure)
      return true
    } catch (error) {
      warnSkillsRefreshFailure(error)
      return false
    }
  }

  return {
    /** @returns {string[]} a fresh snapshot; mutating it never affects the adapter */
    get warnings() {
      return warnings.slice()
    },
    /**
     * Take the warnings collected since the previous call and reset the buffer.
     * @returns {string[]} this batch's warnings
     */
    takeWarnings() {
      const batch = warnings.slice()
      warnings.length = 0
      return batch
    },
    listTools,
    listPlugins,
    listSkills,
    sessionEvents,
    dispatchSupport,
    createDispatchSession,
    promptDispatchSession,
    readDispatchEvents,
    toolFaceSupport,
    prepareWorkerToolFace,
    forgetWorkerToolFace,
    takeWorkerToolFaceReport,
    refreshSkillsCatalog,
    profilePath,
    dshVersion,
  }
}
