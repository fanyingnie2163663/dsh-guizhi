/**
 * Read-only disk skill scanner (真机缺陷 B：host skills.list 清单滞后).
 *
 * The DSH skills service is the authority for a session's catalog, but a skill
 * file that lands in a disk skills root can stay invisible to `skills.list()`
 * until the host itself observes that write. This module reads the same roots
 * directly and returns each skill's name/source, so the HostAdapter can merge
 * disk discoveries into the host catalog.
 *
 * Pure I/O: node:fs/promises + the `yaml` dependency. It never imports a host
 * service, never writes, and never throws for an unreadable/foreign/oversized
 * entry. Only the leading frontmatter window is read (64 KiB by default);
 * files above 1 MiB are skipped outright, so a huge skill body never enters
 * the probe. Accepted frontmatter requires a kebab-case `name` and a string
 * `description`.
 *
 * @module @fanyingnie/dsh-guizhi/skillscan
 */
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** A skill name must be a kebab-case ASCII slug. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whole-file cap: a file above this is skipped without reading content. */
const DEFAULT_MAX_SKILL_BYTES = 1024 * 1024

/** Frontmatter window: only these leading bytes are read and parsed. */
const DEFAULT_MAX_FRONTMATTER_BYTES = 64 * 1024

/** Leading YAML frontmatter delimited by `---` lines. */
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {{name?: unknown}} a @param {{name?: unknown}} b */
function byEntryName(a, b) {
  const left = typeof a?.name === 'string' ? a.name : ''
  const right = typeof b?.name === 'string' ? b.name : ''
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Parse the leading YAML frontmatter of a skill file. A UTF-8 BOM is
 * tolerated. Returns null when the delimiters are missing, the YAML is
 * invalid, or the document is not a mapping.
 * @param {unknown} text
 * @returns {Record<string, unknown> | null}
 */
export function parseSkillFrontmatter(text) {
  if (typeof text !== 'string' || text === '') return null
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = FRONTMATTER_PATTERN.exec(source)
  if (match === null) return null
  try {
    const parsed = parseYaml(match[1])
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Validate parsed frontmatter into the scan fact, or null. The frontmatter
 * `name` is authoritative (not the directory/file name).
 * @param {unknown} data
 * @returns {{name: string} | null}
 */
function skillFact(data) {
  if (!isRecord(data)) return null
  const { name } = data
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) return null
  if (typeof data.description !== 'string') return null
  return { name }
}

/**
 * Read one candidate skill file. Opens first so size is checked before any
 * content is read; reads at most the frontmatter window. Every failure
 * degrades to null.
 * @param {string} file
 * @param {{ maxSkillBytes: number, maxFrontmatterBytes: number }} limits
 * @returns {Promise<{name: string} | null>}
 */
async function readSkillFile(file, limits) {
  let handle
  try {
    handle = await open(file, 'r')
    const info = await handle.stat()
    if (typeof info?.isFile === 'function' && !info.isFile()) return null
    if (info.size > limits.maxSkillBytes) return null
    const window = Math.min(info.size, limits.maxFrontmatterBytes)
    if (window <= 0) return null
    const buffer = Buffer.alloc(window)
    const { bytesRead } = await handle.read(buffer, 0, window, 0)
    return skillFact(parseSkillFrontmatter(buffer.subarray(0, bytesRead).toString('utf8')))
  } catch {
    return null
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // Closing a read handle is best-effort; the scan result never depends on it.
      }
    }
  }
}

/** @param {{ maxSkillBytes?: unknown, maxFrontmatterBytes?: unknown }} options */
function normalizeLimits(options) {
  const maxSkillBytes =
    typeof options?.maxSkillBytes === 'number' && Number.isFinite(options.maxSkillBytes) && options.maxSkillBytes > 0
      ? options.maxSkillBytes
      : DEFAULT_MAX_SKILL_BYTES
  const maxFrontmatterBytes =
    typeof options?.maxFrontmatterBytes === 'number' && Number.isFinite(options.maxFrontmatterBytes) && options.maxFrontmatterBytes > 0
      ? options.maxFrontmatterBytes
      : DEFAULT_MAX_FRONTMATTER_BYTES
  return { maxSkillBytes, maxFrontmatterBytes }
}

/**
 * Scan one root: `<name>/SKILL.md` packages and `<name>.md` flat skills.
 * Entries are visited in name order for a deterministic first-wins result;
 * hidden entries and symlinks are skipped; failures contribute nothing.
 * @param {string} root
 * @param {{ maxSkillBytes: number, maxFrontmatterBytes: number }} limits
 * @returns {Promise<{name: string}[]>}
 */
async function scanRoot(root, limits) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  if (!Array.isArray(entries)) return []
  entries.sort(byEntryName)
  const facts = []
  for (const entry of entries) {
    if (typeof entry?.name !== 'string' || entry.name === '' || entry.name.startsWith('.')) continue
    if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue
    let candidate
    if (typeof entry.isDirectory === 'function' && entry.isDirectory()) {
      candidate = join(root, entry.name, 'SKILL.md')
    } else if (typeof entry.isFile === 'function' && entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      candidate = join(root, entry.name)
    } else {
      continue
    }
    const fact = await readSkillFile(candidate, limits)
    if (fact !== null) facts.push(fact)
  }
  return facts
}

/**
 * Scan disk skill roots and return `{ name, source }` rows.
 *
 * Roots are visited in order; the first occurrence of a frontmatter name wins
 * (and keeps that root's `source`). A missing/unreadable root, an invalid
 * root entry, an invalid frontmatter, a broken YAML block and an oversized
 * file are all skipped without throwing.
 *
 * @param {{ path: string, source?: string }[]} roots
 * @param {{ maxSkillBytes?: number, maxFrontmatterBytes?: number }} [options]
 * @returns {Promise<{ name: string, source?: string }[]>}
 */
export async function scanSkillRoots(roots, options = {}) {
  if (!Array.isArray(roots)) return []
  const limits = normalizeLimits(options)
  /** @type {{ name: string, source?: string }[]} */
  const found = []
  const seen = new Set()
  for (const root of roots) {
    if (!isRecord(root) || typeof root.path !== 'string' || root.path === '') continue
    const source = typeof root.source === 'string' && root.source !== '' ? root.source : undefined
    for (const fact of await scanRoot(root.path, limits)) {
      if (seen.has(fact.name)) continue
      seen.add(fact.name)
      found.push(source === undefined ? { name: fact.name } : { name: fact.name, source })
    }
  }
  return found
}
