/**
 * Scan: aggregate the host's read-only capability facts into the D7 scan
 * document and join the usage facts onto it.
 *
 * The scan answers "what do I have" (plugins, tools, skills, 30-day usage); it
 * never writes to disk and never calls a model. Two review contracts are load
 * bearing here:
 *
 * - Review Focus #1: a blank section is only legitimate when the source really
 *   is empty. Every missing/throwing/malformed host service leaves a warning,
 *   and the host's own warnings (e.g. a broken cordis.patch.yml) are passed
 *   through untouched.
 * - Review Focus #2 / D12: when usage is unknown, used30d and lastUsedAt stay
 *   null. They are never coerced to 0, and totals.unusedTools only counts tools
 *   with a *known* zero.
 *
 * Owner attribution (Review Focus #4 / D8): the same tool name may be
 * registered by several plugins, so owners merge every row's `owner` (deduped,
 * first-seen order). When no row has owner metadata, owners stays [] and one
 * warning says attribution is unavailable — no source is ever invented.
 *
 * @module @fanyingnie/dsh-guizhi/scan
 */
import { describeError } from './host.js'

/**
 * @typedef {object} ToolFact
 * @property {string} name
 * @property {string} description
 * @property {string[]} owners
 */

/**
 * @typedef {object} UsageView
 * @property {boolean} unknown
 * @property {Map<string, unknown>} byTool
 */

/**
 * Read one list service without throwing. A missing service, a thrown call and
 * a non-array result each degrade to an empty list plus a readable warning.
 * @param {object} host
 * @param {'listPlugins' | 'listTools' | 'listSkills'} method
 * @param {string} label human name used in the warning
 * @param {string[]} warnings
 * @returns {Promise<unknown[]>}
 */
async function readFacts(host, method, label, warnings) {
  let read
  try {
    read = host[method]
  } catch (error) {
    warnings.push('host.' + method + ' 读取失败：' + describeError(error))
    return []
  }
  if (typeof read !== 'function') {
    warnings.push('host.' + method + ' 不可用：' + label + '清单为空')
    return []
  }
  let value
  try {
    value = await read.call(host)
  } catch (error) {
    warnings.push('host.' + method + ' 失败：' + describeError(error))
    return []
  }
  if (!Array.isArray(value)) {
    warnings.push('host.' + method + ' 返回结构异常（应为数组）：' + label + '清单为空')
    return []
  }
  return value
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize plugin rows to the D7 plugin shape. A row without a name or a
 * source cannot be represented without inventing data, so it is skipped and
 * counted in one summary warning.
 * @param {unknown[]} rows
 * @param {string[]} warnings
 * @returns {{ name: string, version?: string, source: string }[]}
 */
function collectPlugins(rows, warnings) {
  const plugins = []
  let invalid = 0
  for (const row of rows) {
    const name = isRecord(row) && typeof row.name === 'string' ? row.name : ''
    const source = isRecord(row) && typeof row.source === 'string' && row.source !== '' ? row.source : ''
    if (name === '' || source === '') {
      invalid += 1
      continue
    }
    const plugin = { name }
    if (isRecord(row) && typeof row.version === 'string' && row.version !== '') plugin.version = row.version
    plugin.source = source
    plugins.push(plugin)
  }
  if (invalid > 0) warnings.push('host.listPlugins 有 ' + invalid + ' 条无效行被忽略（缺少 name/source）')
  return plugins
}

/**
 * Normalize skill rows to the D7 skill shape; `source` is optional and is
 * omitted when the host does not provide it.
 * @param {unknown[]} rows
 * @param {string[]} warnings
 * @returns {{ name: string, source?: string }[]}
 */
function collectSkills(rows, warnings) {
  const skills = []
  let invalid = 0
  for (const row of rows) {
    const name = isRecord(row) && typeof row.name === 'string' ? row.name : ''
    if (name === '') {
      invalid += 1
      continue
    }
    const source = isRecord(row) && typeof row.source === 'string' && row.source !== '' ? row.source : ''
    const skill = { name }
    if (source !== '') skill.source = source
    skills.push(skill)
  }
  if (invalid > 0) warnings.push('host.listSkills 有 ' + invalid + ' 条无效行被忽略（缺少 name）')
  return skills
}

/**
 * Group tool rows by name and merge their owners (review focus #4).
 *
 * The first registration decides the description; a later non-empty one fills
 * an empty description. Owner order is first-seen and deduplicated. When every
 * row lacks owner metadata, owners stay [] and one warning is emitted (D8).
 * @param {unknown[]} rows
 * @param {string[]} warnings
 * @returns {ToolFact[]}
 */
function collectTools(rows, warnings) {
  /** @type {Map<string, ToolFact>} */
  const tools = new Map()
  let invalid = 0
  let rowsWithOwner = 0
  for (const row of rows) {
    if (!isRecord(row) || typeof row.name !== 'string' || row.name === '') {
      invalid += 1
      continue
    }
    const description = typeof row.description === 'string' ? row.description : ''
    let tool = tools.get(row.name)
    if (tool === undefined) {
      tool = { name: row.name, description, owners: [] }
      tools.set(row.name, tool)
    } else if (tool.description === '' && description !== '') {
      tool.description = description
    }
    const owner = typeof row.owner === 'string' && row.owner !== '' ? row.owner : ''
    if (owner !== '') {
      rowsWithOwner += 1
      if (!tool.owners.includes(owner)) tool.owners.push(owner)
    }
  }
  if (invalid > 0) warnings.push('host.listTools 有 ' + invalid + ' 条无效行被忽略（缺少 name）')
  if (tools.size > 0 && rowsWithOwner === 0) {
    warnings.push('工具注册快照没有任何 owner 元数据：owners 全部为空，不编造来源')
  }
  return [...tools.values()]
}

/**
 * Normalize the summarizeUsage result. Anything that is not a trustworthy
 * known-usage view becomes unknown, with a warning — never known 0.
 * @param {unknown} usage
 * @param {string[]} warnings
 * @returns {UsageView}
 */
function normalizeUsage(usage, warnings) {
  if (!isRecord(usage)) {
    warnings.push('usage 缺失：用量未知（used30d/lastUsedAt 记为 null）')
    return { unknown: true, byTool: new Map() }
  }
  if (typeof usage.unknown !== 'boolean') {
    warnings.push('usage.unknown 缺失或不是布尔值：用量未知')
    return { unknown: true, byTool: new Map() }
  }
  if (usage.unknown) return { unknown: true, byTool: new Map() }
  if (!(usage.byTool instanceof Map)) {
    warnings.push('usage.byTool 不是 Map：用量未知')
    return { unknown: true, byTool: new Map() }
  }
  return { unknown: false, byTool: usage.byTool }
}

/**
 * Usage for one tool. Known-zero and known-count are distinguished from
 * unknown; a malformed entry is unknown for that tool, never 0.
 * @param {string} name
 * @param {UsageView} usage
 * @param {string[]} warnings
 * @returns {{ used30d: number | null, lastUsedAt: string | null }}
 */
function usageForTool(name, usage, warnings) {
  if (usage.unknown) return { used30d: null, lastUsedAt: null }
  const entry = usage.byTool.get(name)
  if (entry === undefined) return { used30d: 0, lastUsedAt: null }
  const valid = isRecord(entry) && Number.isInteger(entry.count) && entry.count >= 0
  if (!valid) {
    warnings.push('使用量统计条目无效：工具 ' + name + ' 的 count 不是非负整数，used30d 记为 null')
    return { used30d: null, lastUsedAt: null }
  }
  const lastUsedAt = typeof entry.lastUsedAt === 'string' && entry.lastUsedAt !== '' ? entry.lastUsedAt : null
  return { used30d: entry.count, lastUsedAt }
}

/**
 * The scan timestamp from `now`; an unusable now falls back to the current
 * time with a warning so the document stays valid and the caller is told.
 * @param {unknown} now
 * @param {string[]} warnings
 * @returns {string} ISO-8601
 */
function resolveGeneratedAt(now, warnings) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.toISOString()
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString()
  if (typeof now === 'string' && now !== '') {
    const time = Date.parse(now)
    if (!Number.isNaN(time)) return new Date(time).toISOString()
  }
  warnings.push('now 无效：generatedAt 使用当前时间')
  return new Date().toISOString()
}

/**
 * Take a snapshot of the host's accumulated warnings. Read access only: the
 * adapter's batch is never drained here, and its getter returns a copy.
 * @param {object} host
 * @param {string[]} warnings
 * @returns {string[]}
 */
function readHostWarnings(host, warnings) {
  let snapshot
  try {
    snapshot = host.warnings
  } catch (error) {
    warnings.push('host.warnings 读取失败：' + describeError(error))
    return []
  }
  if (!Array.isArray(snapshot)) {
    warnings.push('host.warnings 不可用或不是数组：无法透传宿主告警')
    return []
  }
  return snapshot.filter((message) => typeof message === 'string' && message !== '')
}

/**
 * Build the D7 scan document from host facts plus a summarizeUsage result.
 *
 * The host is a createHostAdapter-shaped adapter; only listTools/listPlugins/
 * listSkills and the warnings snapshot are used (session logs are summarized
 * by summarizeUsage, not here). The function never throws: each failure is a
 * warning and an empty section.
 *
 * @param {{
 *   host?: unknown,
 *   usage?: unknown,
 *   now?: unknown,
 * }} [input]
 * @returns {Promise<{
 *   plugins: { name: string, version?: string, source: string }[],
 *   tools: { name: string, description: string, owners: string[], used30d: number | null, lastUsedAt: string | null }[],
 *   skills: { name: string, source?: string }[],
 *   totals: { plugins: number, tools: number, skills: number, unusedTools: number },
 *   warnings: string[],
 *   generatedAt: string,
 * }>}
 */
export async function scanFacts({ host, usage, now } = {}) {
  /** @type {string[]} */
  const warnings = []
  const usableHost = host !== null && typeof host === 'object'
  if (!usableHost) warnings.push('host 不可用：插件/工具/技能清单为空')

  const pluginRows = usableHost ? await readFacts(host, 'listPlugins', '插件', warnings) : []
  const toolRows = usableHost ? await readFacts(host, 'listTools', '工具', warnings) : []
  const skillRows = usableHost ? await readFacts(host, 'listSkills', '技能', warnings) : []

  const plugins = collectPlugins(pluginRows, warnings)
  const toolFacts = collectTools(toolRows, warnings)
  const skills = collectSkills(skillRows, warnings)
  const usageView = normalizeUsage(usage, warnings)
  const tools = toolFacts.map((tool) => {
    const stat = usageForTool(tool.name, usageView, warnings)
    return {
      name: tool.name,
      description: tool.description,
      owners: tool.owners,
      used30d: stat.used30d,
      lastUsedAt: stat.lastUsedAt,
    }
  })
  const generatedAt = resolveGeneratedAt(now, warnings)
  const hostWarnings = usableHost ? readHostWarnings(host, warnings) : []

  return {
    plugins,
    tools,
    skills,
    totals: {
      plugins: plugins.length,
      tools: tools.length,
      skills: skills.length,
      unusedTools: tools.filter((tool) => tool.used30d === 0).length,
    },
    warnings: [...warnings, ...hostWarnings],
    generatedAt,
  }
}
