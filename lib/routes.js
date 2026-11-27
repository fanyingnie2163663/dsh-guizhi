/**
 * Guizhi host routes + stow_* tool shells (Task 7).
 *
 * Two entry points share one implementation:
 * - createRoutes({deps}) builds fourteen payload handlers
 *   (GET /api/guizhi/state + GET /api/guizhi/pipeline/status + twelve POST endpoints). Each handler receives the
 *   parsed body (or query object) and resolves to { status, json }; it never
 *   throws, so the HTTP adapter in lib/index.js only has to serialize results.
 * - registerTools({deps}) returns the ten stow_* tools as {name, handler}
 *   thin shells over those same handlers. lib/index.js wraps them with
 *   defineTool (D11: only that file imports @deepseek-ai/dsh-tools).
 *
 * Route paths are root-absolute (the host mounts them on its origin); the
 * browser half mirrors them document-relative (api/guizhi/...) so a sub-path
 * deployment still reaches them (docs/host-notes.md §6).
 *
 * deps (all injected): host (withAttribution adapter), store (data root JSON),
 * home ($DSH_HOME/guizhi for apply/rollback), now (optional clock),
 * catalog (loader fn | preloaded {entries,stale,error} | options {url,cacheDir,
 * ttlMs}; absent => <home>/sources.json), fetchImpl (catalog fetch).
 *
 * Error semantics (Task 6 handoff): ApplyError.code maps to 400/404/500 through
 * APPLY_ERROR_STATUS; request-shape errors are 400; real I/O failures are 500
 * with a readable message. No handler writes anything before its validation
 * passes. apply owns the snapshot-before-change boundary for installs; the
 * one-click pipeline takes its own 'before-pipeline' snapshot before the first
 * state write, stops at preview (never applies) and hands its snapshotId back.
 *
 * S2 opt-in: the apply route forwards deps.skillsHome ONLY for
 * body.installSkill === true (default false). Without it apply keeps the old
 * pack-only behavior; with it, a broken skills root or a failed skill write
 * degrades to a readable warning and never rolls back the exported packs.
 *
 * stow_draft accepts an optional packId: with it the draft is built from that
 * stored pack (parent→child dispatch payload, soft constraint) instead of the
 * full scan result.
 *
 * S3 (experimental): dispatch kind='pack' builds the worker prompt from one
 * stored pack and asks the host to restrict the worker Agent's tool surface to
 * the pack's tools (agent/created + agent.ctx.tools.restrict). A host without
 * that capability degrades to a soft-constraint dispatch with a warning; a host
 * that does not adopt the pre-generated Session id drops the planned allowlist.
 * run_code and own-scope tools are NOT guaranteed to be hidden.
 *
 * @module @fanyingnie/dsh-guizhi/routes
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { buildAdvice } from './advice.js'
import { ApplyError, apply, preview, rollback } from './apply.js'
import { loadCatalog, matchGaps } from './catalog.js'
import {
  DISPATCH_KIND_MAP,
  DISPATCH_KIND_PACK,
  allowedToolsForPack,
  buildMapPrompt,
  buildPackWorkerPrompt,
  createDispatchRecord,
  deriveDispatchState,
  describeDispatch,
  isSessionMissingError,
} from './dispatch.js'
import { describeError } from './host.js'
import { buildPack, isPackEmpty } from './packs.js'
import { normalizeScenarios, truncateCustom } from './scenarios.js'
import { skillNameForPack } from './skillpack.js'
import { scanFacts } from './scan.js'
import { schemas } from './schemas.js'
import { summarizeUsage } from './usage.js'

/** Route paths shared by the mount code, the panel and the tests. */
export const ROUTE_PATHS = Object.freeze({
  state: '/api/guizhi/state',
  scan: '/api/guizhi/scan',
  scenarios: '/api/guizhi/scenarios',
  map: '/api/guizhi/map',
  pack: '/api/guizhi/pack',
  gaps: '/api/guizhi/gaps',
  preview: '/api/guizhi/preview',
  apply: '/api/guizhi/apply',
  rollback: '/api/guizhi/rollback',
  draft: '/api/guizhi/draft',
  dispatch: '/api/guizhi/dispatch',
  pipeline: '/api/guizhi/pipeline',
  pipelineStatus: '/api/guizhi/pipeline/status',
  sources: '/api/guizhi/sources',
})

/**
 * ApplyError.code -> HTTP status (Task 6 handoff table); unknown codes are 500.
 *
 * F7: ROLLBACK_FAILED is reserved for a missing snapshot / invalid id (404);
 * a snapshot that exists but cannot be restored is ROLLBACK_RESTORE_FAILED and
 * stays 500. F2: PACK_NOT_FOUND / PACKS_INVALID are request-shape errors (400).
 */
const APPLY_ERROR_STATUS = Object.freeze({
  INVALID_INPUT: 400,
  IDS_INVALID: 400,
  IDS_EMPTY: 400,
  UNKNOWN_PROPOSAL: 400,
  NO_PROPOSALS: 400,
  PROPOSALS_INVALID: 400,
  PACK_NOT_FOUND: 400,
  PACK_INVALID: 400,
  PACKS_INVALID: 400,
  SNAPSHOT_INVALID: 400,
  SKILL_TARGET_UNSAFE: 400,
  LEDGER_CORRUPT: 400,
  LEDGER_UNSAFE_PATH: 400,
  ROLLBACK_FAILED: 404,
})

/** Rolling usage window (must match lib/usage.js DEFAULT_WINDOW_DAYS). */
const USAGE_WINDOW_DAYS = 30

/** F2: how many generated packs store('packs') keeps before dropping the oldest. */
const PACKS_LIMIT = 50

/** The ten tools the panel buttons and the session agent share (D7; S3 adds stow_dispatch). */
export const TOOL_SPECS = Object.freeze([
  Object.freeze({
    name: 'stow_scan',
    kind: 'route',
    path: ROUTE_PATHS.scan,
    concurrencySafe: true,
    description: '扫描本机 DSH 的插件、工具、技能与近 30 天用量，写入 scan 状态并返回扫描结果 JSON。只读采集；用量未知时 used30d 是 null（不是 0）。',
    parameters: {},
  }),
  Object.freeze({
    name: 'stow_status',
    kind: 'status',
    concurrencySafe: true,
    description: '返回归置状态的汇总：插件数/工具数/技能数、近 30 天未用数、用量是否未知、最近扫描时间、是否已有地图与提案数。',
    parameters: {},
  }),
  Object.freeze({
    name: 'stow_map_save',
    kind: 'route',
    path: ROUTE_PATHS.map,
    concurrencySafe: false,
    description: '保存工作流地图（D7 map 文档：scenarios + stages[capabilities]；冗余能力点可带 suggestion 精简建议），先按 schemas.map 校验，通过后写入 map 状态。',
    parameters: { map: { type: 'json', required: true, description: 'D7 地图文档（任意 JSON；形状见 lib/map.js，保存前按 schemas.map 校验；capability.suggestion 可选）' } },
  }),
  Object.freeze({
    name: 'stow_pack_build',
    kind: 'route',
    path: ROUTE_PATHS.pack,
    concurrencySafe: false,
    description:
      '按已保存的地图与阶段选择派生装配清单提案（kind=pack，写入 packs 与 proposals 状态，不写 packs/ 文件），返回 {pack,proposal}；工具/技能只从所选阶段的 tools/skills 派生，派生结果为空时该包没有可应用内容（pipeline 的 pack 步骤会 warn 并说明补法），应用时才会在快照保护下导出能力包文件。',
    parameters: {
      stageIds: { type: 'array', required: true, description: '要合并的阶段 id 列表（来自已保存地图的 stages[].id）' },
      title: { type: 'string', required: true, description: '能力包标题（同一标题+阶段选择得到确定性 id）' },
    },
  }),
  Object.freeze({
    name: 'stow_gaps',
    kind: 'route',
    path: ROUTE_PATHS.gaps,
    concurrencySafe: false,
    description:
      '用已保存的地图与公共目录源查缺补漏：新 catalog 安装提案替换旧 catalog 提案，保留 pack 等非 catalog 提案并按 id 去重后写回 proposals 状态；目录不可达时返回空结果 + 明确 error（fail-open，不假装没有缺口）。',
    parameters: {},
  }),
  Object.freeze({
    name: 'stow_preview',
    kind: 'route',
    path: ROUTE_PATHS.preview,
    concurrencySafe: true,
    description: '预览将要应用的提案（只读）：返回逐条 {id,kind,title,effect} 与稳定 hash。ids 省略表示全部提案。',
    parameters: { ids: { type: 'array', description: '要预览的提案 id 列表；省略表示全部' } },
  }),
  Object.freeze({
    name: 'stow_apply',
    kind: 'route',
    path: ROUTE_PATHS.apply,
    concurrencySafe: false,
    description:
      '应用选中的提案：先建快照再导出装配清单（能力包）文件。默认只导出装配清单；installSkill=true 时才把非空清单安装为工作流技能到 $DSH_HOME/skills（可回滚）。install/skill 提案仍只返回 warning。返回 {applied,warnings,snapshotId,skills}；失败可能带 snapshotId 供回滚。',
    parameters: {
      ids: { type: 'array', required: true, description: '要应用的提案 id 列表（不默认应用全部）' },
      installSkill: {
        type: 'boolean',
        description: '是否安装工作流技能到 $DSH_HOME/skills（默认 false，只导出装配清单；true 时安装并写入回滚台账）',
      },
    },
  }),
  Object.freeze({
    name: 'stow_rollback',
    kind: 'route',
    path: ROUTE_PATHS.rollback,
    concurrencySafe: false,
    description:
      '按快照回滚一次 apply：删除该次记录的能力包文件、恢复/删除那次 apply 安装的工作流技能（若有）并恢复状态快照，幂等；返回 {restored:true}。',
    parameters: { snapshotId: { type: 'string', required: true, description: 'apply 返回的 snapshotId（或 store 快照列表里的 id）' } },
  }),
  Object.freeze({
    name: 'stow_draft',
    kind: 'route',
    path: ROUTE_PATHS.draft,
    concurrencySafe: true,
    description:
      '生成一段可粘贴给对话的派单草稿（「这个活只需要 A/B/C」）：默认基于最近扫描结果；传 packId 时改为按该装配清单生成父→子派单载荷（阶段/能力点、建议工具/技能、执行步骤、验收清单，软约束）。只返回文本，面板不会代发、也不会塞进输入框。',
    parameters: {
      kind: { type: 'string', required: true, description: "草稿类型，v1 仅支持 'dispatch'" },
      packId: {
        type: 'string',
        description: '可选装配清单 id（store(packs) 里的 pack.id）；给了就按该清单生成派单载荷，不再读全量扫描结果',
      },
    },
  }),
  Object.freeze({
    name: 'stow_dispatch',
    kind: 'route',
    path: ROUTE_PATHS.dispatch,
    concurrencySafe: false,
    description:
      '派发一个后台执行会话（单飞：已有 running 记录时返回冲突）。kind="map"：按已保存场景拆解工作流地图（v1 行为）。kind="pack"（S3 实验性）：按装配清单派发受限 worker——用 pack 的工具生成 allowlist，在子代理创建时尝试裁剪工具面；不保证隐藏 run_code 与归置自身注册的工具，宿主不支持工具面限制或未采用预生成会话 id 时降级为纯软约束并返回 warning（响应含 toolFaceApplied 字段）。',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        description: "派单类型：'map'（地图拆解）或 'pack'（按装配清单的受限 worker）",
      },
      packId: {
        type: 'string',
        description: '可选装配清单 id（store(packs) 里的 pack.id）；kind="pack" 时必填，kind="map" 时忽略',
      },
    },
  }),
])

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A 200 response. @param {unknown} json */
function ok(json) {
  return { status: 200, json }
}

/** @param {string} message @param {Record<string, unknown>} [details] */
function badRequest(message, details) {
  const error = new Error(message)
  error.status = 400
  if (isPlainObject(details)) Object.assign(error, details)
  return error
}

/** @param {string} message @param {string} code */
function internalError(message, code) {
  const error = new Error(message)
  error.status = 500
  error.code = code
  return error
}

/** A 409 response: one background dispatch is already running. @param {string} message */
function conflict(message) {
  const error = new Error(message)
  error.status = 409
  return error
}

/** A 503 response: the host lacks the services a background dispatch needs. @param {string} message */
function unavailable(message) {
  const error = new Error(message)
  error.status = 503
  return error
}

/** A 502 response: the host failed to create the Session or admit the prompt. @param {string} message */
function dispatchFailed(message) {
  const error = new Error(message)
  error.status = 502
  return error
}

/** Normalize the request payload: absent body = {}, a non-object body is 400. */
function requireBody(payload) {
  if (payload === undefined || payload === null) return {}
  if (!isPlainObject(payload)) throw badRequest('请求体必须是 JSON 对象')
  return payload
}

/** Resolve deps.now (Date | number | string | function) to a Date. */
function resolveNow(deps) {
  const value = typeof deps.now === 'function' ? deps.now() : deps.now
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'string' && value !== '') {
    const time = Date.parse(value)
    if (!Number.isNaN(time)) return new Date(time)
  }
  return new Date()
}

/**
 * Session-read warning marker (fix round 1, S1 narrowing): the host adapter
 * emits these when sessionQuery / session log reads degrade (sessionEvents
 * warns with a sessionQuery or 会话 prefix). Only these warnings make the usage
 * summary untrustworthy; an unrelated host warning must not discard known
 * counts.
 */
const SESSION_READ_WARNING = /sessionQuery|会话/

/** @param {string} message @returns {boolean} whether it signals a session read failure */
function isSessionReadWarning(message) {
  return typeof message === 'string' && SESSION_READ_WARNING.test(message)
}

/**
 * De-duplicate warnings while keeping first-seen order (a host warning batch may
 * repeat the same message; the persisted scan document must not).
 * @param {string[]} messages
 * @returns {string[]}
 */
function uniqueWarnings(messages) {
  const seen = new Set()
  const unique = []
  for (const message of messages) {
    if (typeof message !== 'string' || message === '' || seen.has(message)) continue
    seen.add(message)
    unique.push(message)
  }
  return unique
}

/** Read the adapter warnings snapshot without ever throwing. */
function hostWarnings(host) {
  try {
    const snapshot = host?.warnings
    return Array.isArray(snapshot) ? snapshot.filter((message) => typeof message === 'string' && message !== '') : []
  } catch {
    return []
  }
}

/** Warnings that appeared between two snapshots (seam S1: session read failed). */
function addedWarnings(before, after) {
  const counts = new Map()
  for (const message of before) counts.set(message, (counts.get(message) ?? 0) + 1)
  const added = []
  for (const message of after) {
    const remaining = counts.get(message) ?? 0
    if (remaining > 0) counts.set(message, remaining - 1)
    else added.push(message)
  }
  return added
}

/** Read one state document without ever throwing; failures become { value:null, error }. */
async function readStateDocument(deps, name, warnings) {
  let result
  try {
    const store = deps.store
    if (!isPlainObject(store) || typeof store.read !== 'function') throw new Error('store 不可用（缺少 read）')
    result = await store.read(name)
  } catch (error) {
    const message = '读取状态「' + name + '」失败：' + describeError(error)
    if (Array.isArray(warnings)) warnings.push(message)
    return { value: null, error: message }
  }
  if (!isPlainObject(result)) {
    const message = '读取状态「' + name + '」返回结构异常（应为 {value,error}）'
    if (Array.isArray(warnings)) warnings.push(message)
    return { value: null, error: message }
  }
  const error = typeof result.error === 'string' && result.error !== '' ? result.error : null
  if (error !== null && Array.isArray(warnings)) warnings.push(error)
  return { value: result.value ?? null, error }
}

/** Write one state document, turning an I/O failure into a 500. */
async function writeStateDocument(deps, name, value) {
  try {
    const store = deps.store
    if (!isPlainObject(store) || typeof store.write !== 'function') throw new Error('store 不可用（缺少 write）')
    await store.write(name, value)
  } catch (error) {
    throw internalError('写入状态「' + name + '」失败：' + describeError(error), 'STATE_WRITE_FAILED')
  }
}

/** Map a thrown error to the HTTP envelope; handler bodies are wrapped in this. */
function failure(error) {
  if (error instanceof ApplyError) {
    const code = typeof error.code === 'string' ? error.code : ''
    const status = Object.hasOwn(APPLY_ERROR_STATUS, code) ? APPLY_ERROR_STATUS[code] : 500
    const json = { error: error.message }
    if (code !== '') json.code = code
    if (typeof error.snapshotId === 'string' && error.snapshotId !== '') json.snapshotId = error.snapshotId
    return { status, json }
  }
  const status = typeof error?.status === 'number' ? error.status : 500
  const json = { error: describeError(error) }
  if (typeof error?.code === 'string' && error.code !== '') json.code = error.code
  if (Array.isArray(error?.errors)) json.errors = error.errors
  // S1-B: a pipeline failure after its snapshot points at the rollback anchor.
  if (typeof error?.snapshotId === 'string' && error.snapshotId !== '') json.snapshotId = error.snapshotId
  return { status, json }
}

/** Wrap one handler so it always resolves to { status, json }. @param {(payload: unknown) => Promise<object>} run */
function guarded(run) {
  return async (payload) => {
    try {
      return await run(payload)
    } catch (error) {
      return failure(error)
    }
  }
}

/** Parse one <home>/sources.json document (tolerant: catalog.url / catalogUrl / url). */
function parseSourcesDocument(value) {
  if (!isPlainObject(value)) return { url: '', cacheDir: '' }
  const catalog = isPlainObject(value.catalog) ? value.catalog : null
  const url =
    typeof value.catalogUrl === 'string'
      ? value.catalogUrl
      : typeof value.url === 'string'
        ? value.url
        : catalog !== null && typeof catalog.url === 'string'
          ? catalog.url
          : ''
  const cacheDir =
    catalog !== null && typeof catalog.cacheDir === 'string' ? catalog.cacheDir : typeof value.cacheDir === 'string' ? value.cacheDir : ''
  return { url, cacheDir }
}

/** Normalize a loadCatalog/fake result into { entries, stale, error }. */
function normalizeCatalogResult(result, prefix) {
  const entries =
    isPlainObject(result) && Array.isArray(result.entries) ? result.entries.filter((entry) => isPlainObject(entry)) : []
  const stale = isPlainObject(result) && result.stale === true
  let error = isPlainObject(result) && typeof result.error === 'string' && result.error !== '' ? result.error : null
  if (typeof prefix === 'string' && prefix !== '') error = error === null ? prefix : prefix + '；' + error
  return { entries, stale, error }
}

/** Resolve + run the catalog adapter; fail-open (Review Focus #3: no fake "no gaps"). */
async function loadCatalogForDeps(deps) {
  const injected = deps.catalog
  const now = resolveNow(deps)
  if (typeof injected === 'function') {
    try {
      return normalizeCatalogResult(await injected({ now }), '')
    } catch (error) {
      return { entries: [], stale: false, error: '目录加载失败：' + describeError(error) }
    }
  }
  if (isPlainObject(injected) && Array.isArray(injected.entries)) return normalizeCatalogResult(injected, '')
  const config = isPlainObject(injected) ? injected : {}
  let configWarning = ''
  let url = typeof config.url === 'string' ? config.url : ''
  let cacheDir = typeof config.cacheDir === 'string' ? config.cacheDir : ''
  if (url === '') {
    const sourcesRead = await readStateDocument(deps, 'sources', null)
    if (sourcesRead.error !== null) {
      configWarning = '读取目录源配置失败：' + sourcesRead.error
    } else {
      const parsed = parseSourcesDocument(sourcesRead.value)
      url = parsed.url
      if (cacheDir === '') cacheDir = parsed.cacheDir
    }
  }
  if (url === '' && configWarning === '') {
    return { entries: [], stale: false, error: '还没有配置目录源：在工作流页「目录源」填入目录 JSON 地址并保存' }
  }
  if (cacheDir === '' && typeof deps.home === 'string' && deps.home !== '') cacheDir = join(deps.home, 'catalog')
  const fetchImpl = deps.fetchImpl ?? (typeof config.fetchImpl === 'function' ? config.fetchImpl : undefined)
  let result
  try {
    result = await loadCatalog({
      url,
      cacheDir,
      now,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(Number.isFinite(config.ttlMs) ? { ttlMs: config.ttlMs } : {}),
    })
  } catch (error) {
    return { entries: [], stale: false, error: '目录加载失败：' + describeError(error) }
  }
  return normalizeCatalogResult(result, configWarning)
}

/** Build the paste-ready dispatch draft (bridge 1, D14); never claims auto-send. */
function buildDraftText(scan) {
  const tools = isPlainObject(scan) && Array.isArray(scan.tools) ? scan.tools.filter((tool) => isPlainObject(tool) && typeof tool.name === 'string' && tool.name !== '') : []
  const skills = isPlainObject(scan) && Array.isArray(scan.skills) ? scan.skills.filter((skill) => isPlainObject(skill) && typeof skill.name === 'string' && skill.name !== '') : []
  const toolNames = tools.slice(0, 20).map((tool) => tool.name)
  const skillNames = skills.slice(0, 10).map((skill) => skill.name)
  const lines = []
  if (toolNames.length > 0) {
    lines.push('这个活只需要：' + toolNames.join(' / ') + (tools.length > toolNames.length ? ' 等 ' + tools.length + ' 个工具' : ''))
  } else {
    lines.push('这个活只需要：先用归置面板扫描本机能力，再按扫描结果列出该带哪几个工具（当前还没有扫描结果）。')
  }
  if (skillNames.length > 0) {
    lines.push('可带技能（skills）：' + skillNames.join(' / ') + (skills.length > skillNames.length ? ' 等' : ''))
  }
  lines.push('')
  lines.push('说明：这是归置面板生成的派单草稿，只是给会话里的 agent 一个软约束；面板不会把它塞进输入框、不会代发，也不会实际限制工具面。请复制后自行粘贴/发送。')
  return lines.join('\n')
}

/** Collapse whitespace and keep non-empty string names, de-duplicated in order. */
function draftNames(value) {
  if (!Array.isArray(value)) return []
  const names = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.replace(/\s+/g, ' ').trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/** Read one single-line string field from an open pack row. */
function draftRowText(row, key) {
  if (!isPlainObject(row) || typeof row[key] !== 'string') return ''
  return row[key].replace(/\s+/g, ' ').trim()
}

/** Group pack rows by stage (first-seen order); unusable rows are skipped. */
function groupDraftRows(rows) {
  const groups = []
  const byKey = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlainObject(row)) continue
    const stageId = draftRowText(row, 'stageId')
    const stageTitle = draftRowText(row, 'stageTitle')
    const key = stageId || stageTitle
    if (key === '') continue
    let group = byKey.get(key)
    if (group === undefined) {
      group = { title: stageTitle || stageId, rows: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
}

/**
 * Build the pack-aware parent→child dispatch draft (D14, soft constraint).
 *
 * Structured and self-contained: title, stage/capability rows, suggested
 * tools/skills, execution steps, acceptance checklist and the explicit
 * "soft constraint" sentence. Deterministic: no local path, usage figure or
 * timestamp, and it never claims the tool surface is hard-limited.
 * @param {object} pack stored, schema-validated pack
 * @returns {string}
 */
function buildPackDraftText(pack) {
  const title = typeof pack.title === 'string' && pack.title.trim() !== '' ? pack.title.trim() : pack.id
  const tools = draftNames(pack.tools)
  const skills = draftNames(pack.skills)
  const stageIds = draftNames(pack.stageIds)
  const groups = groupDraftRows(pack.rows)
  const lines = []
  lines.push('归置装配清单派单：' + title)
  lines.push('')
  lines.push('阶段与能力点：')
  if (groups.length === 0) {
    lines.push('（本装配清单没有逐能力点明细）阶段：' + (stageIds.length > 0 ? stageIds.join('、') : '（无）'))
  } else {
    for (const group of groups) {
      lines.push('## ' + group.title)
      for (const row of group.rows) {
        const capability = draftRowText(row, 'capabilityTitle') || draftRowText(row, 'capabilityId') || '未命名能力点'
        const status = draftRowText(row, 'status') || 'unknown'
        const rowTools = draftNames(row.tools)
        const rowSkills = draftNames(row.skills)
        lines.push(
          '- ' + capability + '（' + status + '）：工具 ' + (rowTools.length > 0 ? rowTools.join('、') : '无') +
            '；技能 ' + (rowSkills.length > 0 ? rowSkills.join('、') : '无'),
        )
      }
    }
  }
  lines.push('')
  lines.push('建议工具：' + (tools.length > 0 ? tools.join('、') : '（本装配清单没有工具）'))
  lines.push('建议技能：' + (skills.length > 0 ? skills.join('、') : '（本装配清单没有技能）'))
  lines.push('')
  lines.push('执行步骤：')
  lines.push('1. 按「阶段与能力点」顺序执行；状态为 missing 的能力点先补齐再继续。')
  lines.push('2. 优先使用「建议工具」里的工具完成对应能力点。')
  lines.push('3. 需要方法论时加载「建议技能」里的技能。')
  lines.push('4. 完成后逐项勾选「验收清单」。')
  lines.push('')
  lines.push('验收清单：')
  if (groups.length > 0) {
    for (const group of groups) lines.push('- [ ] 阶段「' + group.title + '」的能力点已全部处理')
  } else {
    for (const id of stageIds) lines.push('- [ ] 阶段 ' + id + ' 已处理')
  }
  lines.push('- [ ] 建议工具已按需使用' + (tools.length > 0 ? '：' + tools.join('、') : '（本清单没有工具）'))
  lines.push('- [ ] 建议技能已按需加载' + (skills.length > 0 ? '：' + skills.join('、') : '（本清单没有技能）'))
  lines.push('')
  lines.push('只使用上述工具/技能；这是软约束，工具面未被硬限制。')
  lines.push('说明：这是归置面板根据装配清单生成的派单草稿，只是给会话里的 agent 一个软约束；面板不会把它塞进输入框、不会代发，请复制后自行粘贴/发送。')
  return lines.join('\n')
}

/** Status summary behind stow_status (state aggregate, never throws). */
async function readStatus(deps) {
  const scanRead = await readStateDocument(deps, 'scan', null)
  const mapRead = await readStateDocument(deps, 'map', null)
  const proposalsRead = await readStateDocument(deps, 'proposals', null)
  const selectionsRead = await readStateDocument(deps, 'selections', null)
  const scan = isPlainObject(scanRead.value) ? scanRead.value : null
  const totals = scan !== null && isPlainObject(scan.totals) ? scan.totals : null
  const tools = scan !== null && Array.isArray(scan.tools) ? scan.tools : []
  const warnings = []
  for (const read of [scanRead, mapRead, proposalsRead, selectionsRead]) {
    if (read.error !== null) warnings.push(read.error)
  }
  return {
    plugins: typeof totals?.plugins === 'number' ? totals.plugins : null,
    tools: typeof totals?.tools === 'number' ? totals.tools : null,
    skills: typeof totals?.skills === 'number' ? totals.skills : null,
    unusedTools: typeof totals?.unusedTools === 'number' ? totals.unusedTools : null,
    usageUnknown: scan === null ? true : tools.every((tool) => isPlainObject(tool) && tool.used30d === null),
    lastScanAt: scan !== null && typeof scan.generatedAt === 'string' ? scan.generatedAt : null,
    hasMap: mapRead.value !== null,
    proposals: isPlainObject(proposalsRead.value) && Array.isArray(proposalsRead.value.items) ? proposalsRead.value.items.length : 0,
    selections: isPlainObject(selectionsRead.value) ? selectionsRead.value : null,
    warnings,
  }
}

/**
 * GET state: the persisted documents, the derived advice view, dispatch state
 * and read warnings. `advice` is a view (never persisted) built from map + scan.
 */
async function runState(deps) {
  const warnings = []
  const state = {}
  for (const name of ['scan', 'map', 'proposals', 'selections', 'sources']) {
    state[name] = (await readStateDocument(deps, name, warnings)).value
  }
  const support = dispatchSupportOf(deps)
  const dispatchRead = await readStateDocument(deps, 'dispatch', warnings)
  let dispatch = null
  if (isPlainObject(dispatchRead.value)) {
    const record = dispatchRead.value
    if (!support.available) {
      dispatch = {
        kind: record.kind,
        sessionId: record.sessionId,
        startedAt: record.startedAt,
        state: 'unknown',
        error: '宿主不支持后台派单状态读取',
      }
    } else if (record.state === 'failed') {
      dispatch = describeDispatch(record, deriveDispatchState(record, null, resolveNow(deps).getTime()))
    } else {
      try {
        const read =
          typeof deps.host.readDispatchEvents === 'function'
            ? await deps.host.readDispatchEvents(record.sessionId)
            : { status: 'unreadable', error: '宿主适配器不支持会话读取' }
        dispatch = describeDispatch(record, deriveDispatchState(record, read, resolveNow(deps).getTime()))
      } catch (error) {
        dispatch = {
          kind: record.kind,
          sessionId: record.sessionId,
          startedAt: record.startedAt,
          state: 'unknown',
          error: describeError(error),
        }
      }
    }
  }
  const advice = buildAdvice({ map: state.map, scan: state.scan })
  return ok({ scan: state.scan, map: state.map, proposals: state.proposals, selections: state.selections, sources: state.sources, advice, dispatch, dispatchSupported: support.available, warnings })
}

/**
 * POST scan: S2 host wiring, S3 awaited usage, S1 before/after warning compare.
 *
 * S1 narrowing (fix round 1): only warnings that signal a session read failure
 * (isSessionReadWarning) degrade usage to unknown; unrelated host warnings are
 * passed through without discarding known counts. scan.warnings is
 * de-duplicated (first-seen order) before persisting.
 */
async function runScan(deps) {
  const now = resolveNow(deps)
  const host = deps.host
  const before = hostWarnings(host)
  const extraWarnings = []
  let usage
  try {
    // F5: push the rolling 30-day window down to the session reader so it can
    // skip reading whole session logs outside the window (event-time filtering
    // in lib/usage.js still runs as the exact check).
    const sinceISO = new Date(now.getTime() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const events = isPlainObject(host) && typeof host.sessionEvents === 'function' ? host.sessionEvents(sinceISO) : null
    usage = await summarizeUsage({ events, now })
  } catch (error) {
    usage = { byTool: new Map(), unknown: true }
    extraWarnings.push('用量统计失败：' + describeError(error))
  }
  const added = addedWarnings(before, hostWarnings(host))
  const sessionFailures = added.filter(isSessionReadWarning)
  if (usage.unknown !== true && sessionFailures.length > 0) {
    usage = { byTool: new Map(), unknown: true }
    for (const message of sessionFailures) {
      extraWarnings.push('会话用量未知（读取会话期间出现告警，不把部分结果当已知）：' + message)
    }
  }
  if (usage.unknown === true) extraWarnings.push('用量统计不可用：used30d 记为 null（未知，不是 0）')
  const scan = await scanFacts({ host, usage, now })
  scan.warnings = uniqueWarnings([...scan.warnings, ...extraWarnings])
  const check = schemas.scan.validate(scan)
  if (!check.ok) throw internalError('扫描结果未通过 schema 校验：' + check.errors.join('；'), 'SCAN_INVALID')
  await writeStateDocument(deps, 'scan', scan)
  return ok(scan)
}

/** POST scenarios: normalize (total function) then persist. */
async function runScenarios(deps, payload) {
  const body = requireBody(payload)
  if (body.selected !== undefined && !Array.isArray(body.selected)) throw badRequest('selected 必须是字符串数组')
  if (body.custom !== undefined && typeof body.custom !== 'string') throw badRequest('custom 必须是字符串')
  const normalized = normalizeScenarios(body)
  await writeStateDocument(deps, 'selections', normalized)
  return ok(normalized)
}

/** POST map (stow_map_save): validate through the authoritative schemas.map, then write. */
async function runMapSave(deps, payload) {
  const body = requireBody(payload)
  if (body.map === undefined) throw badRequest('map 字段必填（D7 地图文档）')
  // F7: one 200-code-point rule for custom text on both scenario and map paths.
  const map =
    isPlainObject(body.map) && typeof body.map.custom === 'string'
      ? { ...body.map, custom: truncateCustom(body.map.custom) }
      : body.map
  const check = schemas.map.validate(map)
  if (!check.ok) throw badRequest('地图校验失败：' + check.errors.join('；'), { errors: check.errors })
  await writeStateDocument(deps, 'map', map)
  return ok({ ok: true })
}

/**
 * Read the stored map, refusing a missing/corrupt document with a 400.
 *
 * D7 appended semantics (fix round 1, controller-ruled): pack/gaps with no
 * saved map answer 400 code=NO_MAP and write nothing, so an empty result can
 * never overwrite existing proposals or export an empty pack.
 */
async function requireStoredMap(deps) {
  const mapRead = await readStateDocument(deps, 'map', null)
  if (mapRead.error !== null) throw badRequest('地图状态不可用：' + mapRead.error, { code: 'MAP_INVALID' })
  if (mapRead.value === null) throw badRequest('还没有工作流（请先用 stow_map_save 保存工作流，再一键整理）', { code: 'NO_MAP' })
  const check = schemas.map.validate(mapRead.value)
  if (!check.ok) throw badRequest('地图数据格式不符：' + check.errors.join('；'), { errors: check.errors, code: 'MAP_INVALID' })
  return mapRead.value
}

/**
 * One-line human description of a pack proposal (R-PACK): names the pack and
 * its tool/skill counts so the preview row reads without opening the JSON, then
 * says what apply will do with the workflow skill (S2). The skill name comes
 * from lib/skillpack.js so the preview and the installer cannot drift apart.
 * @param {object} pack
 * @returns {string}
 */
function describePackProposal(pack) {
  const base = '导出装配清单 ' + pack.title + '（' + pack.tools.length + ' 个工具 / ' + pack.skills.length + ' 个技能）'
  if (isPackEmpty(pack)) return base + '；清单为空，应用时跳过技能安装'
  try {
    return base + '；应用时可选择安装工作流技能 ' + skillNameForPack(pack) + '（默认不安装）'
  } catch {
    // A hand-edited pack id may be unusable as a skill name: never throw while
    // merely building a proposal row; the opt-in install path will refuse.
    return base + '；清单 id 无法作为技能名，应用时跳过技能安装'
  }
}

/**
 * Build the next proposals document for one upsert (R-PACK), without writing it.
 *
 * The document keeps the D7 shape { items, generatedAt }. A proposal with the
 * same id is replaced in place, so regenerating the same pack is idempotent
 * (one 生成装配清单 click can never append a twin); every other item is
 * preserved. generatedAt moves to the injected clock because the document is
 * about to be rewritten. An unreadable or shape-invalid proposals document is
 * refused with 400 instead of being clobbered.
 *
 * @param {object} deps
 * @param {{ id: string, kind: string, title: string, effect: string, evidence: object }} proposal
 * @returns {Promise<object>} the validated next document
 */
async function prepareProposalUpsert(deps, proposal) {
  const read = await readStateDocument(deps, 'proposals', null)
  if (read.error !== null) {
    throw badRequest('提案状态不可用，无法写入能力包提案：' + read.error, { code: 'PROPOSALS_INVALID' })
  }
  let items = []
  if (read.value !== null) {
    const existing = schemas.proposals.validate(read.value)
    if (!existing.ok) {
      throw badRequest('提案数据格式不符，无法写入能力包提案（不覆盖原有提案）：' + existing.errors.join('；'), {
        code: 'PROPOSALS_INVALID',
        errors: existing.errors,
      })
    }
    items = read.value.items.slice()
  }
  const index = items.findIndex((item) => item.id === proposal.id)
  if (index >= 0) items[index] = proposal
  else items.push(proposal)
  const next = { items, generatedAt: resolveNow(deps).toISOString() }
  const check = schemas.proposals.validate(next)
  if (!check.ok) {
    throw internalError('能力包提案写入前未通过 schema 校验：' + check.errors.join('；'), 'PROPOSALS_INVALID')
  }
  return next
}

/** Upsert one proposal into the proposals state document (write half). */
async function upsertProposal(deps, proposal) {
  await writeStateDocument(deps, 'proposals', await prepareProposalUpsert(deps, proposal))
}

/**
 * Build the next 'packs' document for one upsert (F2/R-8A), without writing it.
 *
 * The document is { packs: Pack[] }: a pack with the same id is replaced in
 * place, every other stored pack is preserved, and the list stays at
 * PACKS_LIMIT rows by dropping the oldest rows (with a warning the caller
 * returns to the panel). An unreadable or shape-invalid document is refused
 * with 400 instead of being clobbered.
 *
 * @param {object} deps @param {object} pack a schemas.pack-valid pack
 * @returns {Promise<{ document: { packs: object[] }, warnings: string[] }>}
 */
async function preparePackUpsert(deps, pack) {
  const read = await readStateDocument(deps, 'packs', null)
  if (read.error !== null) {
    throw badRequest('能力包存储不可用，无法保存能力包：' + read.error, { code: 'PACKS_INVALID' })
  }
  let packs = []
  if (read.value !== null) {
    const existing = schemas.packs.validate(read.value)
    if (!existing.ok) {
      throw badRequest('能力包存储格式不符，无法保存能力包（不覆盖原有存储）：' + existing.errors.join('；'), {
        code: 'PACKS_INVALID',
        errors: existing.errors,
      })
    }
    packs = read.value.packs.slice()
  }
  const warnings = []
  const index = packs.findIndex((row) => row.id === pack.id)
  if (index >= 0) packs[index] = pack
  else packs.push(pack)
  while (packs.length > PACKS_LIMIT) {
    const dropped = packs.shift()
    warnings.push(
      '能力包存储已达上限 ' + PACKS_LIMIT + ' 条，已丢弃最旧的能力包：' +
        String(isPlainObject(dropped) ? dropped.title ?? dropped.id : ''),
    )
  }
  const document = { packs }
  const check = schemas.packs.validate(document)
  if (!check.ok) {
    throw internalError('能力包存储写入前未通过 schema 校验：' + check.errors.join('；'), 'PACKS_INVALID')
  }
  return { document, warnings }
}

/**
 * POST pack (stow_pack_build, R-PACK + R-8A): build the pack from the stored
 * map, store it in the 'packs' state document and persist it as one kind='pack'
 * proposal — never export a file. The panel chain becomes /pack (proposal) →
 * /preview → /apply (snapshot + ledger + backup + exportPack) → /rollback
 * (restore/delete + state restore), so the only packs/ write stays inside the
 * snapshot boundary (design §10) and /pack never bypasses the preview.
 * R-8A: apply later exports exactly this stored pack, so a map edit between
 * /pack and /apply cannot make preview and disk disagree. Both state documents
 * are validated before the first write, so a corrupt file is never overwritten
 * and a proposal never points at a pack that was not stored.
 */
async function runPack(deps, payload) {
  const body = requireBody(payload)
  const map = await requireStoredMap(deps)
  let pack
  try {
    pack = buildPack({ map, stageIds: body.stageIds, title: body.title })
  } catch (error) {
    throw badRequest(
      '生成装配清单失败：' + describeError(error),
      Array.isArray(error?.errors) ? { errors: error.errors } : undefined,
    )
  }
  const proposal = {
    id: pack.id,
    kind: 'pack',
    title: pack.title,
    effect: describePackProposal(pack),
    evidence: { source: 'map', refs: pack.stageIds.slice() },
  }
  const proposals = await prepareProposalUpsert(deps, proposal)
  const packed = await preparePackUpsert(deps, pack)
  await writeStateDocument(deps, 'packs', packed.document)
  await writeStateDocument(deps, 'proposals', proposals)
  const response = { pack, proposal }
  if (packed.warnings.length > 0) response.warnings = packed.warnings
  return ok(response)
}

/**
 * Read the existing proposals document for the gaps merge.
 *
 * A merge must never clobber proposals it could not read or parse, so an
 * unreadable or shape-invalid document is a 400 PROPOSALS_INVALID instead of
 * being silently replaced by the catalog result.
 * @param {object} deps
 * @returns {Promise<object[]>} existing items ([] when the document is missing)
 */
async function readProposalsForMerge(deps) {
  const read = await readStateDocument(deps, 'proposals', null)
  if (read.error !== null) throw badRequest('现有提案状态不可用，无法合并缺口提案：' + read.error, { code: 'PROPOSALS_INVALID' })
  if (read.value === null) return []
  const check = schemas.proposals.validate(read.value)
  if (!check.ok) {
    throw badRequest('现有提案数据格式不符，无法合并缺口提案（不覆盖原有提案）：' + check.errors.join('；'), {
      code: 'PROPOSALS_INVALID',
      errors: check.errors,
    })
  }
  return read.value.items
}

/**
 * Merge freshly generated catalog gap proposals into the stored proposals.
 *
 * The catalog owns catalog-sourced items: every stored item whose
 * evidence.source === 'catalog' is dropped and replaced by this run's result.
 * Everything else (e.g. a kind='pack' proposal built from the map) is kept.
 * De-duplication is by id with the freshly generated entry winning, so a stale
 * stored row can never shadow the new catalog result. New entries come first;
 * preserved entries keep their relative order.
 * @param {object[]} generated @param {object[]} existing
 * @returns {object[]}
 */
function mergeGapItems(generated, existing) {
  const items = Array.isArray(generated) ? generated.slice() : []
  const seen = new Set(items.map((item) => item.id))
  for (const item of existing) {
    if (!isPlainObject(item) || item.evidence?.source === 'catalog') continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return items
}

/**
 * POST gaps (stow_gaps): loadCatalog fail-open + matchGaps, then merge.
 *
 * Requires a saved map (D7 appended semantics): 400 NO_MAP, no proposals write.
 * S1-B merge semantics: non-catalog proposals already in the document (a pack
 * built from the map) survive; catalog proposals are replaced by the new run and
 * de-duplicated by id (new entry wins). The merged document is validated before
 * the single write, so a silently dropped pack proposal cannot happen.
 */
async function runGaps(deps) {
  const map = await requireStoredMap(deps)
  const scanRead = await readStateDocument(deps, 'scan', null)
  const warnings = []
  if (scanRead.error !== null) warnings.push('扫描结果不可用：无法排除已安装插件（' + scanRead.error + '）')
  else if (scanRead.value === null) warnings.push('还没有扫描结果：无法排除已安装插件（请先扫描）')
  const catalog = await loadCatalogForDeps(deps)
  const generated = matchGaps({ scan: scanRead.value, map, catalog })
  const items = mergeGapItems(generated, await readProposalsForMerge(deps))
  const proposals = { items, generatedAt: resolveNow(deps).toISOString() }
  const check = schemas.proposals.validate(proposals)
  if (!check.ok) throw internalError('缺口分析结果未通过 schema 校验：' + check.errors.join('；'), 'PROPOSALS_INVALID')
  await writeStateDocument(deps, 'proposals', proposals)
  return ok({ items: proposals.items, error: catalog.error, stale: catalog.stale, generatedAt: proposals.generatedAt, warnings })
}

/** POST preview (stow_preview): pure, apply/preview share one selection resolver. */
async function runPreview(deps, payload) {
  const body = requireBody(payload)
  const proposalsRead = await readStateDocument(deps, 'proposals', null)
  if (proposalsRead.error !== null) {
    throw badRequest('提案状态不可用：' + proposalsRead.error, { code: 'PROPOSALS_INVALID' })
  }
  const scanRead = await readStateDocument(deps, 'scan', null)
  const mapRead = await readStateDocument(deps, 'map', null)
  const result = await preview({
    scan: scanRead.value,
    map: mapRead.value,
    proposals: proposalsRead.value,
    store: deps.store,
    ids: body.ids,
  })
  return ok(result)
}

/**
 * Boolean installSkill opt-in: absent means false; any non-boolean body value is
 * a 400 so a typo ("true" as a string) can never silently change the default.
 * @param {object} body @returns {boolean}
 */
function requireInstallSkill(body) {
  if (body.installSkill === undefined) return false
  if (typeof body.installSkill !== 'boolean') {
    throw badRequest('installSkill 必须是布尔值（true 才安装工作流技能，默认 false 只导出装配清单）', { code: 'INSTALL_SKILL_INVALID' })
  }
  return body.installSkill
}

/** POST apply (stow_apply): apply owns snapshot-before-change; errors carry codes. */
async function runApply(deps, payload) {
  const body = requireBody(payload)
  const installSkill = requireInstallSkill(body)
  const request = { ids: body.ids, store: deps.store, home: deps.home }
  // S2 is opt-in: deps.skillsHome alone must never install anything; only an
  // explicit installSkill=true forwards it to apply (default false).
  if (installSkill) request.skillsHome = deps.skillsHome
  const result = await apply(request)
  return ok(result)
}

/** POST rollback (stow_rollback): idempotent restore of one apply snapshot. */
async function runRollback(deps, payload) {
  const body = requireBody(payload)
  const result = await rollback({ snapshotId: body.snapshotId, store: deps.store, home: deps.home, skillsHome: deps.skillsHome })
  return ok(result)
}

/**
 * Resolve one stored pack for a pack-aware draft or dispatch. A packId that is
 * not a non-empty string is a request-shape error, a missing/unreadable packs
 * document or an unknown id is 400 with a stable code, so the panel can tell
 * the user what to do instead of silently falling back to the scan draft.
 * @param {object} deps @param {unknown} packId @param {string} [purpose] human label for the error text
 * @returns {Promise<object>}
 */
async function readDraftPack(deps, packId, purpose = '生成派单草稿') {
  if (typeof packId !== 'string' || packId.trim() === '') {
    throw badRequest('packId 必须是非空字符串（装配清单 id）', { code: 'PACK_ID_INVALID' })
  }
  const packsRead = await readStateDocument(deps, 'packs', null)
  if (packsRead.error !== null) {
    throw badRequest('装配清单状态不可用：' + packsRead.error, { code: 'PACKS_INVALID' })
  }
  if (packsRead.value === null) {
    throw badRequest('还没有装配清单，无法按 packId ' + purpose + '（请先生成装配清单）', { code: 'PACK_NOT_FOUND' })
  }
  const check = schemas.packs.validate(packsRead.value)
  if (!check.ok) throw badRequest('装配清单存储格式不符：' + check.errors.join('；'), { code: 'PACKS_INVALID' })
  const pack = packsRead.value.packs.find((candidate) => candidate.id === packId)
  if (pack === undefined) {
    throw badRequest('没有找到装配清单 ' + JSON.stringify(packId) + '（请重新生成后再试）', { code: 'PACK_NOT_FOUND' })
  }
  return pack
}

/** POST draft (stow_draft): scan-based or pack-aware dispatch text; never auto-sends. */
async function runDraft(deps, payload) {
  const body = requireBody(payload)
  if (body.kind !== 'dispatch') {
    throw badRequest('draft 需要 kind="dispatch"（v1 只支持派单草稿）' + (body.kind === undefined ? '' : '，收到 ' + JSON.stringify(body.kind)))
  }
  // Pack-aware dispatch (soft constraint): with packId the parent→child payload
  // comes from the stored pack only — the full scan is deliberately not read.
  if (body.packId !== undefined) {
    const pack = await readDraftPack(deps, body.packId)
    return ok({ text: buildPackDraftText(pack) })
  }
  const scanRead = await readStateDocument(deps, 'scan', null)
  return ok({ text: buildDraftText(scanRead.value) })
}

/** Read host.dispatchSupport(); an adapter without it cannot dispatch. @param {object} deps */
function dispatchSupportOf(deps) {
  return typeof deps.host?.dispatchSupport === 'function' ? deps.host.dispatchSupport() : { available: false, reason: '宿主适配器不支持后台派单' }
}

/**
 * One in-process dispatch admission per deps object. The admission marker is
 * set synchronously before the first await, so two concurrent POSTs cannot both
 * pass the persisted-running check (TOCTOU) and duplicate the background agent.
 * @param {object} deps
 * @returns {(() => void) | null} release function, or null when already admitting
 */
const dispatchAdmissions = new WeakMap()
function acquireDispatch(deps) {
  if (deps === null || typeof deps !== 'object') return () => {}
  if (dispatchAdmissions.get(deps) === true) return null
  dispatchAdmissions.set(deps, true)
  return () => {
    dispatchAdmissions.delete(deps)
  }
}

/** Ordered one-click steps; the progress ring uses this count. */
const PIPELINE_STEP_IDS = Object.freeze(['scan', 'gaps', 'pack', 'preview'])

/** Tag of the one snapshot the pipeline takes before its first state write. */
const PIPELINE_SNAPSHOT_TAG = 'before-pipeline'

/** Same id boundary apply/rollback enforce: a snapshot id becomes a path segment. */
const SNAPSHOT_ID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/

/**
 * Warning appended when the derived pack has nothing to apply (S1-B).
 *
 * The pack is still stored and previewed (read-only) so the panel can show the
 * real shape, but the pack step reports warn and this message says how to get
 * content instead of pretending the run produced something.
 */
const EMPTY_PACK_WARNING =
  '地图里没有可派生的工具或技能，装配清单为空，未生成可应用内容；请补阶段 tools/skills 或让能力点 evidence 带 tools/skills'

/** Per-deps in-memory progress for the one-click pipeline (last run only). */
const pipelineProgress = new WeakMap()

/** @returns {object} the idle progress document */
function idlePipelineProgress() {
  return { status: 'idle', percent: 0, step: null, steps: [], startedAt: null, finishedAt: null, error: null }
}

function readPipelineProgress(deps) {
  return pipelineProgress.get(deps) ?? idlePipelineProgress()
}

function writePipelineProgress(deps, patch) {
  const next = { ...readPipelineProgress(deps), ...patch }
  pipelineProgress.set(deps, next)
  return next
}

function markPipelineStep(deps, steps) {
  const last = steps[steps.length - 1] ?? null
  const percent = Math.min(99, Math.round((steps.length / PIPELINE_STEP_IDS.length) * 100))
  writePipelineProgress(deps, { status: 'running', percent, step: last, steps })
}

/** Begin one step: it becomes the reported current work item with its start percentage. */
function beginPipelineStep(deps, steps, id, label) {
  const index = steps.length
  steps.push({ id, label, status: 'running', detail: '' })
  writePipelineProgress(deps, {
    status: 'running',
    percent: Math.round((index / PIPELINE_STEP_IDS.length) * 100),
    step: steps[index],
    steps,
  })
  return index
}

/** Finish one step: replace its status/detail and advance the percentage. */
function finishPipelineStep(deps, steps, index, patch) {
  steps[index] = { ...steps[index], ...patch }
  writePipelineProgress(deps, {
    status: 'running',
    percent: Math.round(((index + 1) / PIPELINE_STEP_IDS.length) * 100),
    step: steps[steps.length - 1],
    steps,
  })
}

/**
 * Take the one pipeline snapshot before the first state write (S1-B).
 *
 * A missing store.snapshot, a throwing snapshot or an unusable id is a 500 and
 * no state has been written yet: a snapshot failure must never be mistaken for
 * a successful run. The id is validated because rollback later uses it as a
 * path segment (the same boundary apply/rollback enforce).
 * @param {object} deps
 * @returns {Promise<string>}
 */
async function snapshotBeforePipeline(deps) {
  const store = deps.store
  if (!isPlainObject(store) || typeof store.snapshot !== 'function') {
    throw internalError('无法创建 pipeline 快照：store 不支持 snapshot，未写入任何状态', 'SNAPSHOT_FAILED')
  }
  let snapshot
  try {
    snapshot = await store.snapshot(PIPELINE_SNAPSHOT_TAG)
  } catch (error) {
    throw internalError('创建 pipeline 快照失败，未写入任何状态：' + describeError(error), 'SNAPSHOT_FAILED')
  }
  const id = isPlainObject(snapshot) ? snapshot.id : undefined
  if (typeof id !== 'string' || !SNAPSHOT_ID.test(id)) {
    throw internalError('pipeline 快照 id 不可用，未写入任何状态：' + JSON.stringify(id), 'SNAPSHOT_INVALID')
  }
  return id
}

/**
 * POST pipeline: the one-click 整理 chain, read-only after its snapshot.
 *
 * 1) snapshot('before-pipeline') — before the first state write, so anything a
 *    later step stores is rollback-able (the response, and a failure's JSON,
 *    carry the snapshotId). A snapshot failure is a 500 with no state written.
 * 2) scan → gaps (merged proposals, fail-open warning) → pack (all saved
 *    stages; an empty pack is a warn) → preview. The chain stops at preview:
 *    applying stays an explicit /apply call and no packs/ file is exported.
 * 3) A failure after the snapshot rethrows with error.snapshotId attached; the
 *    route wrapper writes the failed progress (runPipeline owns no state write
 *    for that marker).
 * @param {object} deps
 * @returns {Promise<{ status: number, json: object }>}
 */
async function runPipeline(deps) {
  // Read the saved map before the snapshot: with no map this call writes
  // nothing, so snapshotting first would only leave an orphan snapshot.
  const map = await requireStoredMap(deps)
  const snapshotId = await snapshotBeforePipeline(deps)
  const steps = []
  writePipelineProgress(deps, { ...idlePipelineProgress(), status: 'running', percent: 0, startedAt: resolveNow(deps).toISOString() })
  try {
    const scanIndex = beginPipelineStep(deps, steps, 'scan', '扫描本机')
    const scan = (await runScan(deps)).json
    const totals = scan !== null && typeof scan === 'object' && scan.totals !== null && typeof scan.totals === 'object' ? scan.totals : {}
    finishPipelineStep(deps, steps, scanIndex, { status: 'ok', detail: '插件 ' + String(totals.plugins ?? '未知') + ' / 工具 ' + String(totals.tools ?? '未知') + ' / 技能 ' + String(totals.skills ?? '未知') })
    const gapsIndex = beginPipelineStep(deps, steps, 'gaps', '查缺补漏')
    let gaps
    try {
      gaps = (await runGaps(deps)).json
      finishPipelineStep(deps, steps, gapsIndex, { status: gaps.error ? 'warn' : 'ok', detail: String(Array.isArray(gaps.items) ? gaps.items.length : 0) + ' 条安装提案' + (gaps.error ? '（目录不可达，fail-open）' : '') })
    } catch (error) {
      gaps = { items: [], error: describeError(error), stale: false, warnings: [] }
      finishPipelineStep(deps, steps, gapsIndex, { status: 'warn', detail: '跳过：' + describeError(error) })
    }
    const stageIds = Array.isArray(map.stages) ? map.stages.map((stage) => stage.id) : []
    const packIndex = beginPipelineStep(deps, steps, 'pack', '生成装配清单')
    const packResult = (await runPack(deps, { stageIds, title: '归置装配清单' })).json
    const pack = packResult.pack
    // S1-B: an empty derived pack has nothing to apply — warn instead of ok.
    const packEmpty = pack.tools.length === 0 && pack.skills.length === 0
    finishPipelineStep(deps, steps, packIndex, {
      status: packEmpty ? 'warn' : 'ok',
      detail: pack.id + '（阶段 ' + String(stageIds.length) + '）' + (packEmpty ? '：装配清单为空' : ''),
    })
    const previewIndex = beginPipelineStep(deps, steps, 'preview', '预览变更')
    const preview = (await runPreview(deps, {})).json
    finishPipelineStep(deps, steps, previewIndex, { status: 'ok', detail: String(Array.isArray(preview.items) ? preview.items.length : 0) + ' 条' })
    const warnings = [
      ...(Array.isArray(gaps.warnings) ? gaps.warnings : []),
      ...(Array.isArray(packResult.warnings) ? packResult.warnings : []),
      ...(packEmpty ? [EMPTY_PACK_WARNING] : []),
    ]
    const response = {
      steps,
      scan: { generatedAt: scan.generatedAt ?? null, totals },
      gaps: { items: Array.isArray(gaps.items) ? gaps.items : [], error: gaps.error ?? null, stale: gaps.stale === true, warnings: Array.isArray(gaps.warnings) ? gaps.warnings : [] },
      pack,
      preview: { hash: preview.hash ?? '', itemCount: Array.isArray(preview.items) ? preview.items.length : 0 },
      warnings,
      snapshotId,
    }
    writePipelineProgress(deps, { status: 'done', percent: 100, step: steps[steps.length - 1] ?? null, steps, finishedAt: resolveNow(deps).toISOString(), error: null })
    return ok(response)
  } catch (error) {
    // The route wrapper writes the failed progress; the id lets the caller roll
    // back whatever this run stored before it failed.
    if (error !== null && typeof error === 'object') error.snapshotId = snapshotId
    throw error
  }
}

/** GET pipeline status: the in-memory progress of the last one-click run. */
async function runPipelineStatus(deps) {
  return ok(readPipelineProgress(deps))
}

/**
 * POST sources: persist the user-supplied format-1 catalog index URL.
 *
 * The panel ("目录源") is the only writer; an empty string clears the source.
 * Only http(s) URLs are accepted — the catalog loader never reads local files
 * and never executes catalog content.
 * @param {object} deps @param {unknown} payload
 * @returns {Promise<{ status: number, json: object }>}
 */
async function runSources(deps, payload) {
  const body = requireBody(payload)
  if (typeof body.url !== 'string') throw badRequest('目录源需要 url 字段（字符串；清空传空字符串）', { code: 'SOURCE_URL_INVALID' })
  const url = body.url.trim()
  if (url.length > 500) throw badRequest('目录源 URL 过长（最多 500 字符）', { code: 'SOURCE_URL_INVALID' })
  if (url !== '') {
    let parsed = null
    try {
      parsed = new URL(url)
    } catch (error) {
      parsed = null
    }
    if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw badRequest('目录源必须是 http(s) 链接，例如 https://example.com/catalog.json', { code: 'SOURCE_URL_INVALID' })
    }
  }
  const savedAt = resolveNow(deps).toISOString()
  await writeStateDocument(deps, 'sources', { url, savedAt })
  return ok({ url, savedAt, configured: url !== '' })
}

/**
 * POST dispatch: admit one background task.
 *
 * kind='map' keeps the v1 map-decomposition flow (single-flight, Session reuse).
 * kind='pack' (S3, experimental) dispatches a constrained worker for one stored
 * pack: the pack's tools become the tool-face allowlist, recorded before the
 * dedicated Session is created so the agent/created hook can restrict that
 * Agent. A host that ignores the pre-generated id or lacks the restriction
 * capability still dispatches a soft-constraint worker and says why in
 * response.warnings; run_code/own-scope tools are not guaranteed to be hidden.
 *
 * Single-flight: a persisted record still running returns 409. A failed
 * admission is persisted as state=failed so the next click can retry instead of
 * hanging.
 * @param {object} deps @param {unknown} payload
 * @returns {Promise<{ status: number, json: object }>}
 */
async function runDispatch(deps, payload) {
  const body = requireBody(payload)
  const isPack = body.kind === DISPATCH_KIND_PACK
  if (!isPack && body.kind !== DISPATCH_KIND_MAP) {
    throw badRequest('kind 必填且只能是 "map" 或 "pack"' + (body.kind === undefined ? '' : '，收到 ' + JSON.stringify(body.kind)))
  }
  const releaseAdmission = acquireDispatch(deps)
  if (releaseAdmission === null) throw conflict('后台派单正在提交，请稍后重试')
  try {
    // 1) Kind-specific input. A pack dispatch reads only the stored pack (never
    // the scan); a map dispatch still requires a saved scenario selection.
    let promptText = ''
    let allowedTools = []
    let selections = null
    if (isPack) {
      const pack = await readDraftPack(deps, body.packId, '派发受限 worker')
      promptText = buildPackWorkerPrompt(pack)
      allowedTools = allowedToolsForPack(pack)
    } else {
      const selectionsRead = await readStateDocument(deps, 'selections', null)
      selections = isPlainObject(selectionsRead.value) ? selectionsRead.value : null
      const selected =
        selections !== null && Array.isArray(selections.selected)
          ? selections.selected.filter((id) => typeof id === 'string' && id !== '')
          : []
      const custom = selections !== null && typeof selections.custom === 'string' ? selections.custom.trim() : ''
      if (selected.length === 0 && custom === '') throw badRequest('先在「场景」页选择场景或填写自定义场景，并保存后再派单拆解地图')
      const scanRead = await readStateDocument(deps, 'scan', null)
      promptText = buildMapPrompt({ scan: scanRead.value, selections })
    }
    const support = dispatchSupportOf(deps)
    if (!support.available) throw unavailable(support.reason === undefined ? '当前宿主不支持后台派单' : support.reason)
    const nowMs = resolveNow(deps).getTime()
    const requestId = randomUUID()
    const previousRead = await readStateDocument(deps, 'dispatch', null)
    const previous = isPlainObject(previousRead.value) ? previousRead.value : null
    let previousReadResult = null
    if (
      previous !== null &&
      typeof previous.sessionId === 'string' &&
      previous.sessionId !== '' &&
      typeof deps.host.readDispatchEvents === 'function'
    ) {
      previousReadResult = await deps.host.readDispatchEvents(previous.sessionId)
    }
    if (previousReadResult !== null && previousReadResult !== undefined && previousReadResult.status === 'unreadable') {
      throw conflict('上一单状态暂时读不到，请稍后重试，避免重复派单')
    }
    const previousState = previous === null ? null : deriveDispatchState(previous, previousReadResult, nowMs)
    if (previousState !== null && previousState.state === 'running') throw conflict('已有一个后台拆解在执行中，请等它结束或稍后重试')
    // A pack worker needs a fresh Session: the allowlist is keyed by the id that
    // will actually be created, so reusing an old Session could not restrict it.
    const reuseSession =
      !isPack &&
      previous !== null &&
      typeof previous.sessionId === 'string' &&
      previous.sessionId !== '' &&
      previousReadResult !== null &&
      previousReadResult !== undefined &&
      previousReadResult.status === 'events'
    let record = null
    let sessionId = ''
    /** S3 pack-dispatch diagnostics surfaced to the caller (soft-constraint fallback). */
    const warnings = []
    let plannedSessionId = ''
    let sessionCreated = false
    let toolFacePrepared = false
    let toolFaceApplied = false
    try {
      if (reuseSession) {
        sessionId = previous.sessionId
      } else if (isPack) {
        plannedSessionId = 'session-' + randomUUID()
        if (typeof deps.host.prepareWorkerToolFace === 'function') {
          try {
            toolFacePrepared = deps.host.prepareWorkerToolFace(plannedSessionId, allowedTools) === true
          } catch (error) {
            warnings.push('工具面限制准备失败：' + describeError(error) + '；本次仅软约束')
            toolFacePrepared = false
          }
          if (!toolFacePrepared) warnings.push('当前宿主不支持工具面限制，本次按软约束派发 worker')
        } else {
          warnings.push('当前宿主适配器不支持工具面限制，本次按软约束派发 worker')
        }
        if (typeof deps.host.createDispatchSession !== 'function') throw new Error('当前宿主不支持创建后台会话')
        sessionId = await deps.host.createDispatchSession({ sessionId: plannedSessionId })
        sessionCreated = true
        if (toolFacePrepared && sessionId === plannedSessionId) {
          toolFaceApplied = true
        } else if (toolFacePrepared) {
          if (typeof deps.host.forgetWorkerToolFace === 'function') deps.host.forgetWorkerToolFace(plannedSessionId)
          warnings.push('宿主未采用预生成会话 id，工具面限制未生效；本次仅软约束')
        }
      } else {
        if (typeof deps.host.createDispatchSession !== 'function') throw new Error('当前宿主不支持创建后台会话')
        sessionId = await deps.host.createDispatchSession()
      }
      record = createDispatchRecord({ kind: isPack ? DISPATCH_KIND_PACK : DISPATCH_KIND_MAP, sessionId, requestId, startedAt: nowMs })
      if (typeof deps.host.promptDispatchSession !== 'function') throw new Error('当前宿主不支持投递后台任务')
      try {
        await deps.host.promptDispatchSession({ sessionId, requestId, text: promptText })
      } catch (error) {
        if (!reuseSession || error === null || typeof error !== 'object' || error.code !== 'DISPATCH_SESSION_MISSING') throw error
        if (typeof deps.host.createDispatchSession !== 'function') throw error
        sessionId = await deps.host.createDispatchSession()
        record = createDispatchRecord({ kind: DISPATCH_KIND_MAP, sessionId, requestId, startedAt: nowMs })
        await deps.host.promptDispatchSession({ sessionId, requestId, text: promptText })
      }
    } catch (error) {
      // A planned allowlist whose Session never came up would leak into a later
      // Agent with the same id; drop it here.
      if (plannedSessionId !== '' && !sessionCreated && typeof deps.host.forgetWorkerToolFace === 'function') {
        try {
          deps.host.forgetWorkerToolFace(plannedSessionId)
        } catch {
          // The original failure is the useful one.
        }
      }
      const failedKind = isPack ? DISPATCH_KIND_PACK : DISPATCH_KIND_MAP
      const failed =
        record !== null
          ? { ...record, state: 'failed', error: describeError(error) }
          : {
              kind: failedKind,
              sessionId: '',
              requestId,
              startedAt: new Date(nowMs).toISOString(),
              state: 'failed',
              error: describeError(error),
            }
      try {
        await writeStateDocument(deps, 'dispatch', failed)
      } catch {
        // The original failure is the useful one.
      }
      if (error !== null && typeof error === 'object' && isSessionMissingError(error)) {
        throw dispatchFailed('后台会话已失效，已写入失败记录，请重试')
      }
      throw dispatchFailed(describeError(error))
    }
    await writeStateDocument(deps, 'dispatch', record)
    const response = { ok: true, dispatch: describeDispatch(record, { state: 'running' }) }
    if (isPack) {
      response.toolFaceApplied = toolFaceApplied
      response.toolFace = { applied: toolFaceApplied, prepared: toolFacePrepared, requested: allowedTools }
      response.warnings = warnings.slice()
    }
    return ok(response)
  } finally {
    releaseAdmission()
  }
}

/** Build the eleven panel route handlers: {method, path, handler(payload) => {status,json}}. */
export function createRoutes({ deps } = {}) {
  const resolved = isPlainObject(deps) ? deps : {}
  return [
    { method: 'GET', path: ROUTE_PATHS.state, handler: guarded(() => runState(resolved)) },
    { method: 'POST', path: ROUTE_PATHS.scan, handler: guarded(() => runScan(resolved)) },
    { method: 'POST', path: ROUTE_PATHS.scenarios, handler: guarded((payload) => runScenarios(resolved, payload)) },
    { method: 'POST', path: ROUTE_PATHS.map, handler: guarded((payload) => runMapSave(resolved, payload)) },
    { method: 'POST', path: ROUTE_PATHS.pack, handler: guarded((payload) => runPack(resolved, payload)) },
    { method: 'POST', path: ROUTE_PATHS.gaps, handler: guarded(() => runGaps(resolved)) },
    { method: 'POST', path: ROUTE_PATHS.preview, handler: guarded((payload) => runPreview(resolved, payload)) },
    { method: 'POST', path: ROUTE_PATHS.apply, handler: guarded((payload) => runApply(resolved, payload)) },
    { method: 'POST', path: ROUTE_PATHS.rollback, handler: guarded((payload) => runRollback(resolved, payload)) },
    { method: 'POST', path: ROUTE_PATHS.draft, handler: guarded((payload) => runDraft(resolved, payload)) },
    { method: 'POST', path: ROUTE_PATHS.dispatch, handler: guarded((payload) => runDispatch(resolved, payload)) },
    { method: 'POST', path: ROUTE_PATHS.sources, handler: guarded((payload) => runSources(resolved, payload)) },
    { method: 'POST', path: ROUTE_PATHS.pipeline, handler: guarded(async () => {
      try {
        return await runPipeline(resolved)
      } catch (error) {
        writePipelineProgress(resolved, { status: 'failed', percent: 100, finishedAt: resolveNow(resolved).toISOString(), error: describeError(error) })
        throw error
      }
    }) },
    { method: 'GET', path: ROUTE_PATHS.pipelineStatus, handler: guarded(() => runPipelineStatus(resolved)) },
  ]
}

/** Thin tool shell: business JSON on success, Error with .status/.payload on failure. */
function toolHandlerFor(spec, route, deps) {
  if (spec.kind === 'status') return async () => readStatus(deps)
  return async (input) => {
    const response = await route.handler(input === undefined ? {} : input)
    if (response.status >= 400) {
      const message = isPlainObject(response.json) && typeof response.json.error === 'string' ? response.json.error : '工具调用失败'
      const error = new Error(message)
      error.name = 'GuizhiToolError'
      error.status = response.status
      error.payload = response.json
      throw error
    }
    return response.json
  }
}

/** Build the ten contract stow_* tools; every handler is a thin createRoutes shell. */
export function registerTools({ deps } = {}) {
  const resolved = isPlainObject(deps) ? deps : {}
  const byPath = new Map(createRoutes({ deps: resolved }).map((route) => [route.path, route]))
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    handler: toolHandlerFor(spec, spec.path === undefined ? undefined : byPath.get(spec.path), resolved),
  }))
}
