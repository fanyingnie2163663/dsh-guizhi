/**
 * Scenarios: the deterministic, built-in starting point for the workflow map.
 *
 * Design §5 (场景页) pins exactly six scenario chips, each an id plus a display
 * title: content|design|dev|research|office|daily -> 内容生产/视觉设计/研发/
 * 调研/办公/日常. They are the only valid values of a saved selection; the user
 * may additionally describe a one-sentence custom scenario, kept as free text
 * and capped at 200 characters.
 *
 * This module is the v1 "确定性种子": it contains no AI decomposition and no
 * I/O. lib/map.js builds the map structure from these ids; capability evidence
 * is filled in later (Task 5/7).
 *
 * normalizeScenarios is total by design: bad input (null, primitives, arrays,
 * unknown ids, non-string entries, oversized text) degrades to an empty or
 * trimmed selection instead of throwing, because it sits on the panel route
 * boundary.
 *
 * @module @fanyingnie/dsh-guizhi/scenarios
 */

/** Hard cap on the custom scenario text, counted in characters (码点). */
export const CUSTOM_MAX_CHARS = 200

/**
 * The six built-in scenario chips (D7 map.scenarios vocabulary), in render
 * order. Frozen: the vocabulary is a contract, not runtime state.
 * @type {ReadonlyArray<{ id: string, title: string }>}
 */
export const BUILTIN_SCENARIOS = Object.freeze([
  Object.freeze({ id: 'content', title: '内容生产' }),
  Object.freeze({ id: 'design', title: '视觉设计' }),
  Object.freeze({ id: 'dev', title: '研发' }),
  Object.freeze({ id: 'research', title: '调研' }),
  Object.freeze({ id: 'office', title: '办公' }),
  Object.freeze({ id: 'daily', title: '日常' }),
])

/** The id vocabulary as a lookup set; derived once so it cannot drift. */
const BUILTIN_IDS = new Set(BUILTIN_SCENARIOS.map((scenario) => scenario.id))

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Truncate by characters (Unicode code points), so a surrogate pair (emoji) is
 * never split into two lone halves. Exported (F7) so the map route applies the
 * exact same 200-code-point rule as the scenario route.
 * @param {string} text
 * @returns {string}
 */
export function truncateCustom(text) {
  const chars = Array.from(text)
  return chars.length > CUSTOM_MAX_CHARS ? chars.slice(0, CUSTOM_MAX_CHARS).join('') : text
}

/**
 * Normalize a scenario selection from the panel / HTTP routes into the D7
 * `{ selected, custom }` pair.
 *
 * - `selected` keeps only known built-in ids, drops non-string entries, removes
 *   duplicates and preserves first-seen order (`[]` when empty/bad);
 * - `custom` is a string capped at 200 characters (`''` when absent/bad);
 * - never throws: null, primitives, arrays and object garbage all degrade.
 *
 * @param {unknown} [input]
 * @returns {{ selected: string[], custom: string }}
 */
export function normalizeScenarios(input) {
  const source = isPlainObject(input) ? input : {}
  /** @type {string[]} */
  const selected = []
  const seen = new Set()
  if (Array.isArray(source.selected)) {
    for (const value of source.selected) {
      if (typeof value !== 'string' || !BUILTIN_IDS.has(value) || seen.has(value)) continue
      seen.add(value)
      selected.push(value)
    }
  }
  const custom = typeof source.custom === 'string' ? truncateCustom(source.custom) : ''
  return { selected, custom }
}
