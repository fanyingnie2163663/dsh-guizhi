/**
 * Self-contained fake HostAdapter for the scanFacts tests (task 2, Step 4).
 *
 * Mirrors the shape returned by createHostAdapter (lib/host.js): async
 * listTools / listPlugins / listSkills plus a read-only `warnings` snapshot.
 * There is no file system, no DSH service and no live profile: each test owns
 * its facts through createFakeHost.
 *
 * Tool rows may carry `owner` (the per-row plugin attribution scanFacts
 * merges). The default fixture registers `read` from two plugins and repeats
 * one owner, pinning "merge all owners, deduplicate".
 *
 * @module test/fixtures/host
 */

/** Plugin rows: npm rows with a version, patch rows without one. */
export const PLUGIN_ROWS = [
  { name: '@fanyingnie/dsh-guizhi', version: '0.1.0', source: 'patch' },
  { name: 'dsh-ops', version: '0.5.6', source: 'npm' },
  { name: 'dsh-better-sidebar', source: 'patch' },
]

/** Tool rows: `read` comes from two plugins and is registered a third time. */
export const TOOL_ROWS = [
  { name: 'read', description: 'Read a UTF-8 text file', owner: '@deepseek-ai/dsh-tool-fs' },
  { name: 'read', description: 'Read a file from the sidebar', owner: 'dsh-better-sidebar' },
  { name: 'write', description: 'Write a UTF-8 text file', owner: '@deepseek-ai/dsh-tool-fs' },
  { name: 'stow_scan', description: '扫描本机插件/技能/工具', owner: '@fanyingnie/dsh-guizhi' },
  { name: 'read', description: 'Repeated registration of read', owner: '@deepseek-ai/dsh-tool-fs' },
]

/** Skill rows: one row with a source, the catalog shape host.js produces. */
export const SKILL_ROWS = [
  { name: 'brainstorming', source: 'user' },
  { name: 'writing-plans', source: 'bundled' },
]

/** A tools snapshot with no owner metadata at all (attribution unavailable). */
export const OWNERLESS_TOOL_ROWS = [
  { name: 'read', description: 'Read a UTF-8 text file' },
  { name: 'grep', description: 'Search file contents' },
]

/** Clone declared rows so a test can never mutate the shared fixtures. */
function cloneRows(value) {
  if (!Array.isArray(value)) return value
  return value.map((row) => (row !== null && typeof row === 'object' && !Array.isArray(row) ? { ...row } : row))
}

/** @param {unknown} message */
function throwIf(message) {
  if (typeof message === 'string' && message !== '') throw new Error(message)
}

/**
 * @param {{
 *   tools?: unknown,
 *   plugins?: unknown,
 *   skills?: unknown,
 *   warnings?: string[],
 *   fail?: { tools?: string, plugins?: string, skills?: string },
 * }} [options]
 * @returns {object} fake HostAdapter
 */
export function createFakeHost(options = {}) {
  const {
    tools = TOOL_ROWS,
    plugins = PLUGIN_ROWS,
    skills = SKILL_ROWS,
    warnings = [],
    fail = {},
  } = options
  const warningLog = Array.isArray(warnings) ? warnings.slice() : []
  return {
    async listTools() {
      throwIf(fail.tools)
      return cloneRows(tools)
    },
    async listPlugins() {
      throwIf(fail.plugins)
      return cloneRows(plugins)
    },
    async listSkills() {
      throwIf(fail.skills)
      return cloneRows(skills)
    },
    /** scanFacts must never read session logs: usage comes from summarizeUsage. */
    sessionEvents() {
      throw new Error('scanFacts 不应读取会话事件日志')
    },
    /** @returns {string[]} a fresh snapshot, like the real adapter */
    get warnings() {
      return warningLog.slice()
    },
  }
}
