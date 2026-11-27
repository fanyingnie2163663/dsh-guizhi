/**
 * Advice: derive the panel's "精简建议" for the capabilities of a saved map.
 *
 * The workflow map (D7) is written by the session agent or the background
 * dispatcher. A capability may carry an explicit `suggestion` string — the map
 * author's human-readable advice, usually written for `redundant` capabilities.
 * When it does not, this module derives a deterministic, fact-only advice from
 * the map's evidence plus the last scan:
 *
 * - which sources (skills / plugins / tools) the map names for the capability;
 * - their 30-day usage when the scan can attribute it. Unknown stays unknown
 *   (never 0) and a known 0 is shown as 0 plus the design's reminder that 0 does
 *   not mean "useless";
 * - the redundancy itself, with the reminder that Guizhi only advises.
 *
 * The result is a view consumed by GET /api/guizhi/state: it is never persisted
 * and never triggers a write, a disable, an uninstall or a profile change.
 * This module is pure (no I/O, no model call).
 *
 * @module @fanyingnie/dsh-guizhi/advice
 */

/** Panel title for advice attached to a redundant capability. */
export const TRIM_TITLE = '精简建议'

/** Panel title for advice attached to any other capability. */
export const ADVICE_TITLE = '建议'

/** The non-negotiable footer: advice is text, never an action. */
export const ADVICE_HINT = '归置只给建议，不会自动停用、卸载或安装任何插件或技能。'

/** Hint for an explicit suggestion written into the map. */
const MAP_HINT = '来自工作流地图；' + ADVICE_HINT

/** Hint for a suggestion derived from evidence + scan usage. */
const DERIVED_HINT = '按地图证据与扫描用量自动归纳；' + ADVICE_HINT

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize one evidence value to a de-duplicated list of non-empty strings.
 * A non-string, empty string or non-array value contributes nothing.
 * @param {unknown} value
 * @returns {string[]}
 */
function nameList(value) {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const names = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * The sources one capability's evidence names, in display order and deduped.
 * @param {unknown} evidence
 * @returns {{ skills: string[], plugins: string[], tools: string[] }}
 */
function capabilitySources(evidence) {
  const source = isPlainObject(evidence) ? evidence : {}
  const merge = (...lists) => {
    const merged = []
    for (const list of lists) {
      for (const name of list) if (!merged.includes(name)) merged.push(name)
    }
    return merged
  }
  return {
    skills: merge(nameList(source.skill), nameList(source.skills)),
    plugins: merge(nameList(source.plugin), nameList(source.plugins)),
    tools: merge(nameList(source.tool), nameList(source.tools)),
  }
}

/**
 * @typedef {object} UsageFact
 * @property {number|null} calls Known calls in the window; null when unknown.
 * @property {boolean} known True only when at least one row had a real count.
 */

/**
 * Index a D7 scan's tool usage by owner plugin and by tool name.
 *
 * A tool whose used30d is not a non-negative integer is unknown, never 0 (D12).
 * A plugin's entry aggregates every tool attributed to it; the entry stays
 * unknown when none of those tools had a real count.
 * @param {unknown} scan
 * @returns {{ byPlugin: Map<string, UsageFact>, byTool: Map<string, UsageFact> }}
 */
export function usageIndex(scan) {
  const byPlugin = new Map()
  const byTool = new Map()
  const tools = isPlainObject(scan) && Array.isArray(scan.tools) ? scan.tools : []
  for (const tool of tools) {
    if (!isPlainObject(tool) || typeof tool.name !== 'string' || tool.name === '') continue
    const calls = Number.isInteger(tool.used30d) && tool.used30d >= 0 ? tool.used30d : null
    const fact = { calls, known: calls !== null }
    byTool.set(tool.name, fact)
    const owners = Array.isArray(tool.owners) ? tool.owners : []
    for (const owner of owners) {
      if (typeof owner !== 'string' || owner === '') continue
      const entry = byPlugin.get(owner) || { calls: 0, known: false }
      if (fact.known) {
        entry.calls += fact.calls
        entry.known = true
      }
      byPlugin.set(owner, entry)
    }
  }
  return { byPlugin, byTool }
}

/**
 * The usage facts worth showing for one capability: its plugins when the
 * evidence names any, otherwise its tools. Capped at four names so the advice
 * stays one readable paragraph.
 * @param {{ plugins: string[], tools: string[] }} sources
 * @param {{ byPlugin: Map<string, UsageFact>, byTool: Map<string, UsageFact> }} usage
 * @returns {{ name: string, kind: 'plugin'|'tool', known: boolean, calls: number|null }[]}
 */
function usageFacts(sources, usage) {
  if (sources.plugins.length > 0) {
    return sources.plugins.slice(0, 4).map((name) => {
      const fact = usage.byPlugin.get(name)
      return { name, kind: 'plugin', known: fact !== undefined && fact.known === true, calls: fact !== undefined && fact.known === true ? fact.calls : null }
    })
  }
  return sources.tools.slice(0, 4).map((name) => {
    const fact = usage.byTool.get(name)
    return { name, kind: 'tool', known: fact !== undefined && fact.known === true, calls: fact !== undefined && fact.known === true ? fact.calls : null }
  })
}

/** One usage fact as a sentence fragment. */
function factText(fact) {
  if (fact.kind === 'plugin') {
    return fact.known ? fact.name + ' 名下工具近 30 天 ' + String(fact.calls) + ' 次' : fact.name + ' 用量未知'
  }
  return fact.known ? fact.name + ' 近 30 天 ' + String(fact.calls) + ' 次' : fact.name + ' 用量未知'
}

/**
 * The candidate names used in the "cover the same capability" sentence:
 * the evidence's skills when it names at least two, otherwise every named
 * skill/plugin/tool (capped) so a mixed pair still reads as a pair.
 * @param {{ skills: string[], plugins: string[], tools: string[] }} sources
 * @returns {string[]}
 */
function displayNames(sources) {
  if (sources.skills.length >= 2) return sources.skills.slice(0, 4)
  const merged = []
  for (const list of [sources.skills, sources.plugins, sources.tools]) {
    for (const name of list) {
      if (merged.length >= 4) break
      if (!merged.includes(name)) merged.push(name)
    }
  }
  return merged
}

/**
 * Deterministic, fact-only advice for one redundant capability.
 *
 * Wording rules from the design's anti-goals: a known 0 is stated as 0 and
 * explicitly "not useless"; unknown usage is never rendered as 0; the advice
 * never tells the user to delete or uninstall anything. When the scan cannot
 * attribute usage, it says so instead of inventing a basis.
 * @param {{ skills: string[], plugins: string[], tools: string[] }} sources
 * @param {{ byPlugin: Map<string, UsageFact>, byTool: Map<string, UsageFact> }} usage
 * @returns {string}
 */
function derivedText(sources, usage) {
  const names = displayNames(sources)
  const parts = []
  if (names.length >= 2) {
    parts.push(names.join('、') + ' 覆盖同一能力，保留一个即可。')
  } else if (names.length === 1) {
    parts.push('这个能力点被标为冗余；' + names[0] + ' 是否仍属于当前工作流，需要你确认。')
  } else {
    parts.push('这个能力点被标为冗余；建议确认它是否仍属于当前工作流，只保留一个来源。')
  }
  const facts = usageFacts(sources, usage)
  if (facts.length > 0) {
    const known = facts.filter((fact) => fact.known)
    const active = known.filter((fact) => fact.calls > 0)
    if (known.length === facts.length) {
      parts.push('近 30 天：' + facts.map(factText).join('；') + '。')
      if (active.length === 1) {
        parts.push('可优先保留 ' + active[0].name + '；其余来源 0 次不代表无用，可先移出常用工作流，需要时再启用。')
      } else if (active.length === 0) {
        parts.push('没有已知调用记录（0 次不代表无用），建议按使用习惯保留一个。')
      } else {
        parts.push('多个来源都有调用记录，建议按使用习惯保留一个。')
      }
    } else if (active.length > 0) {
      parts.push('近 30 天：' + facts.map(factText).join('；') + '。')
      if (active.length === 1) {
        parts.push('只有 ' + active[0].name + ' 有调用记录，可优先保留；其余用量未知，是否移出由你判断。')
      } else {
        parts.push('多个来源有调用记录，另有来源用量未知；建议按使用习惯保留一个。')
      }
    } else {
      parts.push('这组来源的近 30 天用量未知，无法判断主次；按使用习惯选一个即可。')
    }
  } else if (names.length > 0) {
    parts.push('扫描里没有这组来源的用量（技能调用不计入用量），按使用习惯选一个即可。')
  }
  return parts.join('')
}

/**
 * @typedef {object} AdviceItem
 * @property {string} stageId
 * @property {string} capabilityId
 * @property {string} title
 * @property {string} text
 * @property {string} hint
 * @property {'map'|'derived'} source 'map' = written into the map, 'derived' = computed here
 */

/**
 * Build the display advice for one capability, or null when there is nothing
 * worth showing. An explicit map suggestion always wins; otherwise only a
 * redundant capability gets a derived, fact-only suggestion.
 * @param {{ stageId: unknown, capability: unknown, usage: { byPlugin: Map<string, UsageFact>, byTool: Map<string, UsageFact> } }} input
 * @returns {AdviceItem | null}
 */
export function capabilityAdvice({ stageId, capability, usage }) {
  if (!isPlainObject(capability)) return null
  const capabilityId = typeof capability.id === 'string' ? capability.id : ''
  if (capabilityId === '') return null
  const status = typeof capability.status === 'string' ? capability.status : ''
  const explicit = typeof capability.suggestion === 'string' ? capability.suggestion.trim() : ''
  if (explicit !== '') {
    return {
      stageId: String(stageId),
      capabilityId,
      title: status === 'redundant' ? TRIM_TITLE : ADVICE_TITLE,
      text: explicit,
      hint: MAP_HINT,
      source: 'map',
    }
  }
  if (status !== 'redundant') return null
  return {
    stageId: String(stageId),
    capabilityId,
    title: TRIM_TITLE,
    text: derivedText(capabilitySources(capability.evidence), usage),
    hint: DERIVED_HINT,
    source: 'derived',
  }
}

/**
 * Walk a D7 map and derive one advice item per capability that has one.
 * Tolerant of a missing map / malformed rows: it never throws and returns
 * `{ items: [] }` when there is nothing to advise.
 * @param {{ map?: unknown, scan?: unknown }} [input]
 * @returns {{ items: AdviceItem[] }}
 */
export function buildAdvice(input) {
  const source = isPlainObject(input) ? input : {}
  const usage = usageIndex(source.scan)
  const stages = isPlainObject(source.map) && Array.isArray(source.map.stages) ? source.map.stages : []
  const items = []
  for (const stage of stages) {
    if (!isPlainObject(stage)) continue
    const stageId = typeof stage.id === 'string' ? stage.id : ''
    const capabilities = Array.isArray(stage.capabilities) ? stage.capabilities : []
    for (const capability of capabilities) {
      const item = capabilityAdvice({ stageId, capability, usage })
      if (item !== null) items.push(item)
    }
  }
  return { items }
}
