/**
 * Usage facts: summarize local session tool/call events into per-tool call
 * counts and last-used timestamps for a rolling window (D12).
 *
 * The source is the host's session event stream (lib/host.js sessionEvents);
 * this module is a pure function over that stream and never touches disk.
 *
 * Degradation rule (Review Focus #2): when the source is unavailable the
 * summary is { unknown: true } with an empty Map — it is never silently read
 * as "zero calls". A source that dies mid-stream is likewise unknown, because
 * partial counts would look like complete facts.
 *
 * Rows are { tool, at, sessionId } with an ISO-8601 `at`; a raw JSONL line is
 * also accepted (session logs are text) and every unreadable row is skipped
 * instead of throwing.
 *
 * @module @fanyingnie/dsh-guizhi/usage
 */

/** Milliseconds in one window day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Rolling window used when the caller does not specify one. */
const DEFAULT_WINDOW_DAYS = 30

/**
 * @typedef {object} ToolUsage
 * @property {number} count Calls inside the window.
 * @property {string|null} lastUsedAt ISO time of the latest in-window call.
 */

/**
 * @typedef {object} UsageSummary
 * @property {Map<string, ToolUsage>} byTool Per-tool usage; empty when unknown.
 * @property {boolean} unknown True when the event source could not be read, so
 *   every usage number must be displayed as unknown (null) rather than 0.
 */

/** @returns {UsageSummary} an unknown summary; always a fresh Map. */
function unknownSummary() {
  return { byTool: new Map(), unknown: true }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a timestamp without throwing. ISOs from the host are strings; Date and
 * epoch numbers are tolerated because the helper doubles for the `now` input.
 * @param {unknown} value
 * @returns {number | null} epoch milliseconds, or null when unparseable
 */
function parseTime(value) {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value !== '') {
    const time = Date.parse(value)
    return Number.isNaN(time) ? null : time
  }
  return null
}

/** @param {unknown} windowDays @returns {number} a non-negative day count */
function normalizeWindowDays(windowDays) {
  return Number.isFinite(windowDays) && windowDays >= 0 ? windowDays : DEFAULT_WINDOW_DAYS
}

/**
 * Read one event row. Raw JSONL strings are parsed; junk (null, numbers,
 * arrays, missing/empty tool names, unparseable timestamps) yields null so the
 * caller can skip it without knowing why it was unusable.
 * @param {unknown} row
 * @returns {{ tool: string, time: number } | null}
 */
function readEvent(row) {
  let event = row
  if (typeof event === 'string') {
    try {
      event = JSON.parse(event)
    } catch {
      return null
    }
  }
  if (!isRecord(event)) return null
  if (typeof event.tool !== 'string' || event.tool === '') return null
  const time = parseTime(event.at)
  if (time === null) return null
  return { tool: event.tool, time }
}

/**
 * Summarize tool usage from session events.
 *
 * The window is closed on both ends: an event counts when
 * `now - windowDays * 24h <= at <= now`. Older events and clock-skewed future
 * events are outside "the last N days" and are excluded.
 *
 * @param {{
 *   events?: (Iterable<unknown> & object) | AsyncIterable<unknown> | null,
 *   now?: Date | string | number,
 *   windowDays?: number,
 * }} [input]
 * @returns {Promise<UsageSummary>}
 */
export async function summarizeUsage({ events, now, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const nowMs = parseTime(now)
  if (nowMs === null) return unknownSummary()
  if (events === null || events === undefined) return unknownSummary()
  if (typeof events !== 'object') return unknownSummary()
  const iterable = typeof events[Symbol.asyncIterator] === 'function' || typeof events[Symbol.iterator] === 'function'
  if (!iterable) return unknownSummary()

  const cutoff = nowMs - normalizeWindowDays(windowDays) * MS_PER_DAY
  /** @type {Map<string, { count: number, latest: number }>} */
  const collected = new Map()
  try {
    for await (const row of events) {
      const event = readEvent(row)
      if (event === null) continue
      if (event.time < cutoff || event.time > nowMs) continue
      const entry = collected.get(event.tool)
      if (entry === undefined) {
        collected.set(event.tool, { count: 1, latest: event.time })
      } else {
        entry.count += 1
        if (event.time > entry.latest) entry.latest = event.time
      }
    }
  } catch {
    return unknownSummary()
  }

  /** @type {Map<string, ToolUsage>} */
  const byTool = new Map()
  for (const [tool, entry] of collected) {
    byTool.set(tool, { count: entry.count, lastUsedAt: new Date(entry.latest).toISOString() })
  }
  return { byTool, unknown: false }
}
