/**
 * Host capability probe: run the adapter's read-only capabilities and report
 * counts, service availability, and degradation warnings as one JSON-safe object.
 *
 * The probe never throws: a broken adapter method costs that section only and
 * appends a warning, because stow_probe must stay callable on a degraded host.
 *
 * @module @fanyingnie/dsh-guizhi/probe
 */
import { describeError } from './host.js'

/**
 * @typedef {object} ProbeResult
 * @property {number} tools Number of tools visible in the global tool view.
 * @property {number} plugins Number of plugin rows found (profile files, else inventory).
 * @property {number} skills Number of skills in the catalog.
 * @property {boolean} sessionEvents Whether a session tool/call source is available.
 * @property {string} profilePath Resolved profile directory ('' when unknown).
 * @property {string} dshVersion Running harness version ('unknown' when not detectable).
 * @property {string[]} warnings Every degradation that happened during the probe.
 */

/** @param {unknown} adapter @param {string} name @param {string[]} warnings */
async function readList(adapter, name, warnings) {
  if (adapter === null || typeof adapter !== 'object' || typeof adapter[name] !== 'function') {
    warnings.push(`adapter.${name} 不可用`)
    return []
  }
  try {
    const value = await adapter[name]()
    return Array.isArray(value) ? value : []
  } catch (error) {
    warnings.push(`adapter.${name} 失败：${describeError(error)}`)
    return []
  }
}

/** @param {unknown} adapter @param {string[]} warnings */
function readSessionEventsAvailability(adapter, warnings) {
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.sessionEvents !== 'function') {
    warnings.push('adapter.sessionEvents 不可用')
    return false
  }
  try {
    const iterable = adapter.sessionEvents()
    return iterable !== null && typeof iterable === 'object' && typeof iterable[Symbol.asyncIterator] === 'function'
  } catch (error) {
    warnings.push('adapter.sessionEvents 失败：' + describeError(error))
    return false
  }
}

/**
 * @param {unknown} adapter
 * @param {string} name
 * @param {string} fallback
 * @param {string[]} warnings
 */
function readString(adapter, name, fallback, warnings) {
  if (adapter === null || typeof adapter !== 'object' || typeof adapter[name] !== 'function') {
    warnings.push(`adapter.${name} 不可用`)
    return fallback
  }
  try {
    const value = adapter[name]()
    return typeof value === 'string' ? value : fallback
  } catch (error) {
    warnings.push(`adapter.${name} 失败：${describeError(error)}`)
    return fallback
  }
}

/**
 * Probe the host through a HostAdapter.
 * @param {import('./host.js').HostAdapter} adapter
 * @returns {Promise<ProbeResult>}
 */
export async function probeHost(adapter) {
  const warnings = adapter !== null && typeof adapter === 'object' && Array.isArray(adapter.warnings) ? adapter.warnings : []
  const [tools, plugins, skills] = await Promise.all([
    readList(adapter, 'listTools', warnings),
    readList(adapter, 'listPlugins', warnings),
    readList(adapter, 'listSkills', warnings),
  ])
  return {
    tools: tools.length,
    plugins: plugins.length,
    skills: skills.length,
    sessionEvents: readSessionEventsAvailability(adapter, warnings),
    profilePath: readString(adapter, 'profilePath', '', warnings),
    dshVersion: readString(adapter, 'dshVersion', 'unknown', warnings),
    warnings,
  }
}
