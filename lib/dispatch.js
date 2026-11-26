/**
 * Background dispatch: prompt construction and state reduction.
 *
 * The panel hands one map-decomposition task to a dedicated background
 * Session through the host sessionController service. This module is pure (no
 * I/O, no host imports): lib/routes.js supplies the persisted record and the
 * Session event log, so every branch here is unit-testable.
 *
 * State source of truth is the Session event log: the prompt is accepted as a
 * user/message carrying the dispatch requestId, and the turn is done when a
 * turn/end event follows that marker.
 *
 * @module @fanyingnie/dsh-guizhi/dispatch
 */
import { BUILTIN_SCENARIOS } from './scenarios.js'

/** The only dispatch kind v1 accepts. */
export const DISPATCH_KIND_MAP = 'map'

/** A dispatch that never reaches turn/end is reported as timed out after this long. */
export const DISPATCH_TIMEOUT_MS = 15 * 60 * 1000

/** Error codes/messages that mean the background Session no longer exists. */
const SESSION_MISSING_CODES = new Set(['session/not-found', 'session/not_found', 'SESSION_NOT_FOUND'])

/**
 * Classify an error as "the Session no longer exists" so callers can rebuild
 * instead of retrying forever against a deleted or archived Session.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isSessionMissingError(error) {
  if (error === null || typeof error !== 'object') return false
  const codes = [error.code, error.rpcError?.code, error.payload?.code, error.cause?.code]
  if (codes.some((code) => typeof code === 'string' && (SESSION_MISSING_CODES.has(code) || /^session\/.*not[-_ ]?found$/i.test(code)))) return true
  const message = typeof error.message === 'string' ? error.message : ''
  return /session[^\n]{0,80}not[-_ ]?found|会话[^\n]{0,40}(不存在|已删除|找不)/i.test(message)
}

/** Built-in scenario id -> title, derived once so the prompt cannot drift. */
const BUILTIN_TITLES = new Map(BUILTIN_SCENARIOS.map((scenario) => [scenario.id, scenario.title]))

/** Render one scenario as title（id）, falling back to the raw id for unknown values. */
function scenarioLabel(id) {
  const title = typeof id === 'string' ? BUILTIN_TITLES.get(id) : undefined
  return title === undefined ? String(id) : title + '（' + String(id) + '）'
}

/** A count for the prompt: numbers render as-is, everything else is 未知. */
function countText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知'
}

/**
 * Build the background agent prompt for a D7 workflow map.
 * @param {{ scan?: unknown, selections?: unknown }} input
 * @returns {string}
 */
export function buildMapPrompt({ scan, selections } = {}) {
  const totals =
    scan !== null && typeof scan === 'object' && scan.totals !== null && typeof scan.totals === 'object' ? scan.totals : {}
  const selected =
    selections !== null && typeof selections === 'object' && Array.isArray(selections.selected) ? selections.selected : []
  const custom =
    selections !== null && typeof selections === 'object' && typeof selections.custom === 'string' ? selections.custom : ''
  const lines = [
    '你是「归置（stow）」插件的后台执行 agent。任务：根据下面的本机能力和场景选择，产出 D7 工作流地图并用 stow_map_save 保存。',
    '',
    '## 本机扫描摘要',
    '- 插件：' + countText(totals.plugins),
    '- 工具：' + countText(totals.tools),
    '- 技能：' + countText(totals.skills),
    '- 近 30 天未用工具：' + countText(totals.unusedTools),
    '',
    '## 已保存的场景选择',
    '- 内置场景：' + (selected.length > 0 ? selected.map(scenarioLabel).join('、') : '无'),
    ...(custom === '' ? [] : ['- 自定义场景：' + custom]),
    '',
    '## 产出要求',
    '- 调用 stow_scan（如需要）确认现状，然后调用 stow_map_save 保存地图。',
    '- 地图形状（D7）：{ scenarios: string[], custom?: string, stages: [{ id, title, capabilities: [{ id, title, status: "have"|"missing"|"redundant", evidence: object }] }] }。',
    '- 每个阶段 3-6 个能力点；能力点必须来自真实已装插件/工具/技能（evidence 写 source/plugin/tool/skill 等），不要编造。',
    '- 阶段和能力点用中文命名，id 用稳定的短 slug。',
    '',
    '## 边界',
    '- 只调用 stow_* 工具和本机只读信息；不要修改 profile、插件、工作区或任何业务文件，不要安装任何东西，不要调用其它会写入的工具。',
    '- 完成后用一句话汇报结果（保存成功/失败原因），然后结束。',
  ]
  return lines.join('\n')
}

/**
 * Persisted dispatch record; state='running' at admission.
 * @param {{ kind: string, sessionId: string, requestId: string, startedAt: number | string | Date }} input
 * @returns {{ kind: string, sessionId: string, requestId: string, startedAt: string, state: 'running' }}
 */
export function createDispatchRecord({ kind, sessionId, requestId, startedAt }) {
  return Object.freeze({
    kind,
    sessionId,
    requestId,
    startedAt: new Date(startedAt).toISOString(),
    state: 'running',
  })
}

/** @param {unknown} record */
function isoOrUndefined(record) {
  return typeof record === 'string' ? record : undefined
}

/**
 * Derive the public dispatch state from the record and one Session read.
 *
 * The read is tri-state so a transient read failure can never be mistaken for
 * a deleted Session (which would duplicate a still-running background agent).
 * @param {object} record persisted dispatch record
 * @param {{ status: 'events', events: Array<object> } | { status: 'missing' } | { status: 'unreadable', error?: string } | null} read
 * @param {number} now epoch milliseconds
 * @returns {{ state: 'running'|'done'|'failed'|'timeout'|'lost'|'unknown', finishedAt?: string, error?: string }}
 */
export function deriveDispatchState(record, read, now) {
  if (record === null || typeof record !== 'object') return { state: 'lost', error: '派单记录缺失' }
  if (record.state === 'failed') {
    return { state: 'failed', error: typeof record.error === 'string' && record.error !== '' ? record.error : '派单投递失败' }
  }
  if (read === null || read === undefined) return { state: 'unknown', error: '后台会话状态不可读' }
  if (read.status === 'unreadable') {
    return { state: 'unknown', error: typeof read.error === 'string' && read.error !== '' ? '读取后台会话失败：' + read.error : '读取后台会话失败' }
  }
  if (read.status === 'missing') return { state: 'lost', error: '后台会话已丢失（可能已被删除）' }
  if (read.status !== 'events' || !Array.isArray(read.events)) return { state: 'unknown', error: '后台会话读取结果异常' }
  const list = read.events
  const marker = list.find(
    (event) =>
      event !== null &&
      typeof event === 'object' &&
      event.type === 'user/message' &&
      event.data !== null &&
      typeof event.data === 'object' &&
      event.data.source !== null &&
      typeof event.data.source === 'object' &&
      event.data.source.rpcId === record.requestId,
  )
  if (marker !== undefined) {
    const done = list.find(
      (event) => event !== null && typeof event === 'object' && event.type === 'turn/end' && typeof event.seq === 'number' && event.seq > marker.seq,
    )
    if (done !== undefined) {
      return { state: 'done', finishedAt: new Date(done.time).toISOString() }
    }
  }
  const startedAt = Date.parse(record.startedAt)
  if (Number.isFinite(startedAt) && now - startedAt > DISPATCH_TIMEOUT_MS) {
    return { state: 'timeout', error: '后台执行超过 15 分钟仍未结束' }
  }
  return { state: 'running' }
}

/**
 * Public payload for GET state (requestId stays internal).
 * @param {object} record
 * @param {{ state: string, finishedAt?: string, error?: string }} derived
 * @returns {object}
 */
export function describeDispatch(record, derived) {
  const view = { kind: record.kind, sessionId: record.sessionId, startedAt: record.startedAt, state: derived.state }
  if (derived.finishedAt !== undefined) view.finishedAt = isoOrUndefined(derived.finishedAt)
  if (typeof derived.error === 'string' && derived.error !== '') view.error = derived.error
  return view
}
