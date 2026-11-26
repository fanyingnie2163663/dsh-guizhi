/**
 * Guizhi host routes + stow_* tool shells (Task 7).
 *
 * Two entry points share one implementation:
 * - createRoutes({deps}) builds ten payload handlers
 *   (GET /api/guizhi/state + nine POST endpoints). Each handler receives the
 *   parsed body (or query object) and resolves to { status, json }; it never
 *   throws, so the HTTP adapter in lib/index.js only has to serialize results.
 * - registerTools({deps}) returns the nine stow_* tools as {name, handler}
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
 * passes (apply itself owns the snapshot-before-change trust boundary).
 *
 * @module @fanyingnie/dsh-guizhi/routes
 */
import { join } from 'node:path'
import { ApplyError, apply, preview, rollback } from './apply.js'
import { loadCatalog, matchGaps } from './catalog.js'
import { describeError } from './host.js'
import { buildPack } from './packs.js'
import { normalizeScenarios } from './scenarios.js'
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
})

/** ApplyError.code -> HTTP status (Task 6 handoff table); unknown codes are 500. */
const APPLY_ERROR_STATUS = Object.freeze({
  INVALID_INPUT: 400,
  IDS_INVALID: 400,
  IDS_EMPTY: 400,
  UNKNOWN_PROPOSAL: 400,
  NO_PROPOSALS: 400,
  PROPOSALS_INVALID: 400,
  NO_MAP: 400,
  MAP_INVALID: 400,
  PACK_REFS_MISSING: 400,
  PACK_BUILD_FAILED: 400,
  SNAPSHOT_INVALID: 400,
  LEDGER_CORRUPT: 400,
  LEDGER_UNSAFE_PATH: 400,
  ROLLBACK_FAILED: 404,
})

/** The nine tools the panel buttons and the session agent share (D7). */
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
    description: '保存工作流地图（D7 map 文档：scenarios + stages[capabilities]），先按 schemas.map 校验，通过后写入 map 状态。',
    parameters: { map: { type: 'json', required: true, description: 'D7 地图文档（任意 JSON；形状见 lib/map.js，保存前按 schemas.map 校验）' } },
  }),
  Object.freeze({
    name: 'stow_pack_build',
    kind: 'route',
    path: ROUTE_PATHS.pack,
    concurrencySafe: false,
    description: '按已保存的地图与阶段选择生成能力包提案（kind=pack，写入 proposals 状态，不写 packs/ 文件），返回 {pack,proposal}；应用时才会在快照保护下导出能力包文件。',
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
    description: '用已保存的地图与公共目录源查缺补漏，生成安装提案并写入 proposals 状态；目录不可达时返回空结果 + 明确 error（fail-open，不假装没有缺口）。',
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
    description: '应用选中的提案：先建快照再写 pack 文件（v1 不安装插件/技能，只返回 warning），返回 {applied,warnings,snapshotId}；失败可能带 snapshotId 供回滚。',
    parameters: { ids: { type: 'array', required: true, description: '要应用的提案 id 列表（不默认应用全部）' } },
  }),
  Object.freeze({
    name: 'stow_rollback',
    kind: 'route',
    path: ROUTE_PATHS.rollback,
    concurrencySafe: false,
    description: '按快照回滚一次 apply：删除该次记录的能力包文件并恢复状态快照，幂等；返回 {restored:true}。',
    parameters: { snapshotId: { type: 'string', required: true, description: 'apply 返回的 snapshotId（或 store 快照列表里的 id）' } },
  }),
  Object.freeze({
    name: 'stow_draft',
    kind: 'route',
    path: ROUTE_PATHS.draft,
    concurrencySafe: true,
    description: '生成一段可粘贴给对话的派单草稿（「这个活只需要 A/B/C」），基于最近扫描结果；只返回文本，面板不会代发、也不会塞进输入框。',
    parameters: { kind: { type: 'string', required: true, description: "草稿类型，v1 仅支持 'dispatch'" } },
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

/** GET state: the four persisted documents plus read warnings. */
async function runState(deps) {
  const warnings = []
  const state = {}
  for (const name of ['scan', 'map', 'proposals', 'selections']) {
    state[name] = (await readStateDocument(deps, name, warnings)).value
  }
  return ok({ scan: state.scan, map: state.map, proposals: state.proposals, selections: state.selections, warnings })
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
    const events = isPlainObject(host) && typeof host.sessionEvents === 'function' ? host.sessionEvents() : null
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
  const check = schemas.map.validate(body.map)
  if (!check.ok) throw badRequest('地图校验失败：' + check.errors.join('；'), { errors: check.errors })
  await writeStateDocument(deps, 'map', body.map)
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
  if (mapRead.value === null) throw badRequest('还没有工作流地图（请先用 stow_map_save 保存地图）', { code: 'NO_MAP' })
  const check = schemas.map.validate(mapRead.value)
  if (!check.ok) throw badRequest('地图数据格式不符：' + check.errors.join('；'), { errors: check.errors, code: 'MAP_INVALID' })
  return mapRead.value
}

/**
 * One-line human description of a pack proposal (R-PACK): names the pack and
 * its tool/skill counts so the preview row reads without opening the JSON.
 * @param {object} pack
 * @returns {string}
 */
function describePackProposal(pack) {
  return '导出能力包 ' + pack.title + '（' + pack.tools.length + ' 个工具 / ' + pack.skills.length + ' 个技能）'
}

/**
 * Upsert one proposal into the proposals state document (R-PACK).
 *
 * The document keeps the D7 shape { items, generatedAt }. A proposal with the
 * same id is replaced in place, so regenerating the same pack is idempotent
 * (one 生成工具包 click can never append a twin); every other item is
 * preserved. generatedAt moves to the injected clock because the document was
 * just rewritten. An unreadable or shape-invalid proposals document is refused
 * with 400 instead of being clobbered.
 *
 * @param {object} deps
 * @param {{ id: string, kind: string, title: string, effect: string, evidence: object }} proposal
 * @returns {Promise<void>}
 */
async function upsertProposal(deps, proposal) {
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
  await writeStateDocument(deps, 'proposals', next)
}

/**
 * POST pack (stow_pack_build, R-PACK): build the pack from the stored map and
 * persist it as one kind='pack' proposal — never export a file. The panel chain
 * becomes /pack (proposal) → /preview → /apply (snapshot + ledger + exportPack)
 * → /rollback (delete + restore), so the only packs/ write stays inside the
 * snapshot boundary (design §10) and /pack no longer bypasses the preview.
 * The proposal carries the deterministic pack id, the title and
 * evidence.refs=stageIds so apply can rebuild exactly this pack.
 */
async function runPack(deps, payload) {
  const body = requireBody(payload)
  const map = await requireStoredMap(deps)
  let pack
  try {
    pack = buildPack({ map, stageIds: body.stageIds, title: body.title })
  } catch (error) {
    throw badRequest(
      '生成工具包失败：' + describeError(error),
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
  await upsertProposal(deps, proposal)
  return ok({ pack, proposal })
}

/**
 * POST gaps (stow_gaps): loadCatalog fail-open + matchGaps, persist proposals.
 * Requires a saved map (D7 appended semantics): 400 NO_MAP, no proposals write.
 */
async function runGaps(deps) {
  const map = await requireStoredMap(deps)
  const scanRead = await readStateDocument(deps, 'scan', null)
  const warnings = []
  if (scanRead.error !== null) warnings.push('扫描结果不可用：无法排除已安装插件（' + scanRead.error + '）')
  else if (scanRead.value === null) warnings.push('还没有扫描结果：无法排除已安装插件（请先扫描）')
  const catalog = await loadCatalogForDeps(deps)
  const items = matchGaps({ scan: scanRead.value, map, catalog })
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

/** POST apply (stow_apply): apply owns snapshot-before-change; errors carry codes. */
async function runApply(deps, payload) {
  const body = requireBody(payload)
  const result = await apply({ ids: body.ids, store: deps.store, home: deps.home })
  return ok(result)
}

/** POST rollback (stow_rollback): idempotent restore of one apply snapshot. */
async function runRollback(deps, payload) {
  const body = requireBody(payload)
  const result = await rollback({ snapshotId: body.snapshotId, store: deps.store, home: deps.home })
  return ok(result)
}

/** POST draft (stow_draft): bridge-1 dispatch text only; v1 supports 'dispatch'. */
async function runDraft(deps, payload) {
  const body = requireBody(payload)
  if (body.kind !== 'dispatch') {
    throw badRequest('draft 需要 kind="dispatch"（v1 只支持派单草稿）' + (body.kind === undefined ? '' : '，收到 ' + JSON.stringify(body.kind)))
  }
  const scanRead = await readStateDocument(deps, 'scan', null)
  return ok({ text: buildDraftText(scanRead.value) })
}

/** Build the ten panel route handlers: {method, path, handler(payload) => {status,json}}. */
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

/** Build the nine contract stow_* tools; every handler is a thin createRoutes shell. */
export function registerTools({ deps } = {}) {
  const resolved = isPlainObject(deps) ? deps : {}
  const byPath = new Map(createRoutes({ deps: resolved }).map((route) => [route.path, route]))
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    handler: toolHandlerFor(spec, spec.path === undefined ? undefined : byPath.get(spec.path), resolved),
  }))
}
