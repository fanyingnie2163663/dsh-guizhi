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

/** Map-decomposition dispatch: the panel button's original v1 behavior. */
export const DISPATCH_KIND_MAP = 'map'

/** Experimental pack-dispatched constrained worker (S3). */
export const DISPATCH_KIND_PACK = 'pack'

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
    '- 地图形状（D7）：{ scenarios: string[], custom?: string, stages: [{ id, title, capabilities: [{ id, title, status: "have"|"missing"|"redundant", evidence: object, suggestion?: string }] }] }。',
    '- 每个阶段 3-6 个能力点；能力点必须来自真实已装插件/工具/技能（evidence 写 source/plugin/tool/skill 等），不要编造。',
    '- 对 status="redundant" 的能力点，在 capability.suggestion 写一条精简建议：说明保留哪一个插件/技能、可先移出工作流的候选、判断依据（职责重叠 / 近 30 天用量等）；没有可靠依据时如实写「用量未知，建议按使用习惯保留一个」。不要写「无用」「删掉」，不要建议自动卸载，也不要把建议写进 evidence。',
    '- 阶段和能力点用中文命名，id 用稳定的短 slug。',
    '',
    '## 边界',
    '- 只调用 stow_* 工具和本机只读信息；不要修改 profile、插件、工作区或任何业务文件，不要安装任何东西，不要调用其它会写入的工具。',
    '- 完成后用一句话汇报结果（保存成功/失败原因），然后结束。',
  ]
  return lines.join('\n')
}

/** A trimmed non-empty string, or the fallback. @param {unknown} value @param {string} fallback */
function textOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Trimmed non-empty string names from a string array. @param {unknown} value @returns {string[]} */
function cleanNames(value) {
  if (!Array.isArray(value)) return []
  const names = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * The allowlist a pack worker should be restricted to: the pack's declared
 * tools, de-duplicated. Empty/non-string names are dropped, and \`run_code\` is
 * deliberately NOT added — the host may still show it, which is why the worker
 * prompt repeats the soft constraint instead of relying on a hard mask alone.
 * @param {unknown} pack stored pack document
 * @returns {string[]}
 */
export function allowedToolsForPack(pack) {
  const source = pack !== null && typeof pack === 'object' ? pack : {}
  return cleanNames(source.tools)
}

/**
 * Build the structured worker prompt for a pack dispatch (S3).
 *
 * The prompt states the pack stages/capabilities, the exact tool allowlist, the
 * acceptance checklist and the soft-constraint caveat (\`run_code\` and the
 * plugin's own-scope tools may stay visible). It deliberately carries no local
 * paths and no usage counts: those would leak host state into the worker.
 * @param {unknown} pack stored pack document
 * @returns {string}
 */
export function buildPackWorkerPrompt(pack) {
  const source = pack !== null && typeof pack === 'object' ? pack : {}
  const title = textOr(source.title, '未命名装配清单')
  const id = textOr(source.id, '未知 id')
  const rows = Array.isArray(source.rows) ? source.rows : []
  const stageIds = cleanNames(source.stageIds)
  const stages = []
  const seenStages = new Set()
  const capabilityLines = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const stageId = textOr(row.stageId, '')
    const stageTitle = textOr(row.stageTitle, stageId === '' ? '未命名阶段' : stageId)
    const stageKey = stageId === '' ? stageTitle : stageId
    if (!seenStages.has(stageKey)) {
      seenStages.add(stageKey)
      stages.push(stageId === '' ? stageTitle : stageTitle + '（' + stageId + '）')
    }
    const capabilityTitle = textOr(row.capabilityTitle, textOr(row.capabilityId, '未命名能力点'))
    const capabilityId = textOr(row.capabilityId, '')
    const status = textOr(row.status, '未知')
    const rowTools = cleanNames(row.tools)
    const rowSkills = cleanNames(row.skills)
    capabilityLines.push(
      '- ' +
        stageTitle +
        ' / ' +
        capabilityTitle +
        '（' +
        (capabilityId === '' ? '无 id' : capabilityId) +
        '，状态 ' +
        status +
        '）' +
        (rowTools.length > 0 ? '；建议工具：' + rowTools.join('、') : '') +
        (rowSkills.length > 0 ? '；建议技能：' + rowSkills.join('、') : ''),
    )
  }
  if (stages.length === 0) {
    for (const stageId of stageIds) {
      if (seenStages.has(stageId)) continue
      seenStages.add(stageId)
      stages.push(stageId)
    }
  }
  const tools = allowedToolsForPack(source)
  const skills = cleanNames(source.skills)
  const lines = [
    '你是「归置（stow）」派发的受限 worker。任务：严格按下面这份装配清单的阶段执行，只做清单范围内的工作。',
    '',
    '## 装配清单',
    '- 标题：' + title,
    '- id：' + id,
    '- 阶段：' + (stages.length > 0 ? stages.join('、') : '无'),
    '',
    '## 阶段与能力点',
    ...(capabilityLines.length > 0 ? capabilityLines : ['- 本装配清单没有阶段能力点记录。']),
    '',
    '## 只使用以下工具',
    ...(tools.length > 0 ? tools.map((name) => '- ' + name) : ['- 本装配清单没有工具；不要调用清单外的任何工具。']),
    ...(skills.length > 0 ? ['', '## 建议技能', ...skills.map((name) => '- ' + name)] : []),
    '',
    '## 宿主限制与软约束',
    '- 实验性的工具面限制会尽力把 worker 裁到上面的清单；宿主可能仍显示 run_code、归置自身注册的工具或其它豁免工具。',
    '- 若清单外工具仍可见（宿主限制），不要使用它们，也不要用它们绕过清单边界。',
    '- 若完成任务所必需的工具不在清单里，停下来说明缺哪个工具，不要自行改用其它工具。',
    '',
    '## 验收清单',
    '- [ ] 按阶段顺序完成阶段内能力点；每个能力点给出结果或说明为何跳过。',
    '- [ ] 只调用「只使用以下工具」里的工具；清单外工具即使可见也未使用。',
    '- [ ] 不修改清单范围外的工作区、插件或配置。',
    '- [ ] 完成后用一句话汇报结果。',
    '',
    '## 边界',
    '- 这是归置派发的后台 worker，只服务当前装配清单；不要重写清单、不要派发新的 agent。',
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
