/**
 * Catalog adapter + gap proposals: the only seam that reads the public
 * format-1 plugin index (design §7; contract D7).
 *
 * - Fail-open (Review Focus #3): unreachable/non-2xx/broken JSON/malformed
 *   index returns { entries: [], stale: false, error }; a stale cache is used
 *   instead (stale: true) with the error reported — never a silent empty list.
 * - External content is data: catalog strings are only parsed/matched/cached as
 *   JSON; never evaluated, imported or used as a path.
 * - Caching is local and bounded: index-<sha256(url) 前 16 hex>.json is written
 *   temp-file + rename (< 1 MB), so a crash never leaves partial state.
 *
 * parse/match are pure; loadCatalog only writes inside cacheDir. Shape errors
 * become CatalogFormatError and degrade explicitly at the loadCatalog boundary.
 *
 * @module @fanyingnie/dsh-guizhi/catalog
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describeError } from './host.js'

/** Default cache lifetime: 6 hours. */
const DEFAULT_TTL_MS = 21_600_000

/** Upper bound for one catalog HTTP round trip (fail-open on timeout). */
const FETCH_TIMEOUT_MS = 10_000

/** Single-file cap from the global constraints: 1 MB (exclusive). */
const MAX_CACHE_FILE_BYTES = 1024 * 1024

/** Proposals per matchGaps call (contract: at most 20). */
const MAX_GAPS = 20

/** Proposal ids stay short and readable; longer raw ids get a sha256 suffix. */
const MAX_ID_LENGTH = 80

/** Cache file prefix pinned by the contract. */
const CACHE_FILE_PREFIX = 'index-'

/** Optional entry fields accepted from format-1 rows, in output order. */
const ENTRY_OPTIONAL_FIELDS = Object.freeze(['title', 'description', 'version'])

/** Distinguishes temp files of concurrent writers in this process. */
let tempSequence = 0

/**
 * Malformed public catalog index. `.errors` carries readable field paths so a
 * caller can log or surface them; loadCatalog turns this into an `error`
 * string instead of throwing.
 */
export class CatalogFormatError extends Error {
  /** @param {string[] | string} errors */
  constructor(errors) {
    const list = Array.isArray(errors) ? errors.slice() : [String(errors)]
    super('目录格式不符：' + list.join('；'))
    this.name = 'CatalogFormatError'
    this.errors = Object.freeze(list)
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize one entry list (the `plugins` array of the index, or a cache's
 * `entries` array). Undeclared keys are dropped; the four declared keys are
 * the only ones a proposal can ever read.
 * @param {unknown} items
 * @param {string} rootPath
 * @returns {{ entries: Array<{ name: string, title?: string, description?: string, version?: string }>, errors: string[] }}
 */
function normalizeEntries(items, rootPath) {
  /** @type {string[]} */
  const errors = []
  /** @type {Array<{ name: string, title?: string, description?: string, version?: string }>} */
  const entries = []
  if (!Array.isArray(items)) {
    errors.push(rootPath + ': 必须是数组')
    return { entries, errors }
  }
  items.forEach((item, index) => {
    const at = rootPath + '[' + index + ']'
    if (!isPlainObject(item)) {
      errors.push(at + ': 必须是对象')
      return
    }
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      errors.push(at + '.name: 必须是非空字符串')
      return
    }
    /** @type {{ name: string, title?: string, description?: string, version?: string }} */
    const entry = { name: item.name }
    for (const field of ENTRY_OPTIONAL_FIELDS) {
      if (!Object.hasOwn(item, field) || item[field] === undefined) continue
      if (typeof item[field] !== 'string') {
        errors.push(at + '.' + field + ': 必须是字符串')
        continue
      }
      entry[field] = item[field]
    }
    entries.push(entry)
  })
  return { entries, errors }
}

/**
 * Parse one parsed format-1 catalog index.
 *
 * Contract: the root is an object whose `plugins` is an array; every row is an
 * object with a non-empty string `name`; `title` / `description` / `version`
 * are optional strings. A missing or malformed shape throws
 * CatalogFormatError — an empty list is only ever returned for `plugins: []`.
 * Unknown top-level/row keys are ignored (the public index may grow), but they
 * are never copied into the returned entries.
 *
 * @param {unknown} json Parsed JSON (not raw text).
 * @returns {{ entries: Array<{ name: string, title?: string, description?: string, version?: string }> }}
 * @throws {CatalogFormatError}
 */
export function parseFormat1(json) {
  if (!isPlainObject(json)) {
    throw new CatalogFormatError(['(根): 必须是对象（公共目录 format-1 索引）'])
  }
  const { entries, errors } = normalizeEntries(json.plugins, 'plugins')
  if (errors.length > 0) throw new CatalogFormatError(errors)
  return { entries }
}

/** Derive the cache file name: `index-<sha256(url) first 16 hex>.json`. */
function cacheFilePath(cacheDir, url) {
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 16)
  return join(resolve(cacheDir), CACHE_FILE_PREFIX + digest + '.json')
}

/**
 * Read one cache file; missing/corrupt/shape-invalid cache is just a miss (null).
 * @param {string} file
 */
async function readCache(file) {
  let doc
  try {
    doc = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  if (!isPlainObject(doc) || !Number.isFinite(doc.cachedAt)) return null
  const { entries, errors } = normalizeEntries(doc.entries, 'entries')
  if (errors.length > 0) return null
  return { cachedAt: doc.cachedAt, entries }
}

/**
 * Write one cache file atomically (temp + rename); failed writes clean their temp.
 * @param {string} file
 * @param {number} cachedAt
 * @param {string} url
 * @param {object[]} entries
 */
async function writeCache(file, cachedAt, url, entries) {
  const text = JSON.stringify({ url, cachedAt, entries }) + '\n'
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes >= MAX_CACHE_FILE_BYTES) {
    throw new Error('目录缓存超过单文件 1MB 上限：' + bytes + ' 字节')
  }
  await mkdir(dirname(file), { recursive: true })
  tempSequence += 1
  const temp = file + '.' + process.pid + '.' + tempSequence + '.tmp'
  try {
    await writeFile(temp, text)
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Run one catalog request and return the parsed JSON body.
 *
 * Accepts a real fetch Response (`ok`/`status`/`json()`) or an
 * already-parsed object (handy for tests and for hosts that expose another
 * client). Non-2xx, a thrown fetch, a timeout and an unparseable body all throw
 * a plain Error with a readable reason; loadCatalog is what degrades that into
 * `error` without throwing.
 *
 * @param {string} url
 * @param {((url: string, init?: object) => Promise<unknown>) | undefined} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function fetchCatalogJson(url, fetchImpl, timeoutMs) {
  const impl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof impl !== 'function') {
    throw new Error('当前运行时没有可用的 fetch，无法加载目录源')
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller !== null) controller.abort()
      reject(new Error('目录源请求超时（' + timeoutMs + 'ms）'))
    }, timeoutMs)
  })
  const request = Promise.resolve().then(() => impl(url, controller === null ? undefined : { signal: controller.signal }))
  // When the timeout wins the race the request promise may still reject later;
  // attaching a handler keeps that from surfacing as an unhandled rejection.
  request.catch(() => {})
  let response
  try {
    response = await Promise.race([request, timeout])
  } finally {
    clearTimeout(timer)
  }
  if (!isPlainObject(response)) {
    throw new Error('目录源返回的不是 JSON 对象')
  }
  if (typeof response.json === 'function') {
    const status = typeof response.status === 'number' ? response.status : 0
    const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300
    if (!ok) throw new Error('目录源返回 HTTP ' + (status === 0 ? '(非 2xx)' : status))
    try {
      return await response.json()
    } catch (error) {
      throw new Error('目录源返回的 JSON 无法解析：' + describeError(error))
    }
  }
  return response
}

/** Resolve a caller-supplied now (ms number or Date) to epoch milliseconds. */
function toMillis(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.getTime()
  return Date.now()
}

/**
 * Load the public format-1 index with a TTL cache and fail-open degradation.
 *
 * Semantics: fresh cache → cached entries without a request; missing/expired
 * cache → request + parse + atomic cache write; request/format failure →
 * `{ entries: cached, stale: true, error }` when an expired cache exists,
 * else `{ entries: [], stale: false, error }`. Never throws, never calls a
 * model, and only writes the one cache file described above.
 *
 * `error` has two meanings: (1) catalog unavailable — entries empty or from an
 * outdated cache (stale: true); (2) catalog fetched but cache write failed —
 * entries fresh (stale: false), only persistence degraded.
 *
 * @param {{
 *   url?: string,
 *   cacheDir?: string,
 *   now?: number | Date,
 *   fetchImpl?: (url: string, init?: object) => Promise<unknown>,
 *   ttlMs?: number,
 *   timeoutMs?: number,
 * }} [options] `timeoutMs` is an escape hatch for tests (production 10s).
 */
export async function loadCatalog(options = {}) {
  const { url, cacheDir, now, fetchImpl, ttlMs = DEFAULT_TTL_MS, timeoutMs = FETCH_TIMEOUT_MS } = options ?? {}
  const nowMs = toMillis(now)
  const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS
  const timeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : FETCH_TIMEOUT_MS
  if (typeof url !== 'string' || url.trim() === '') {
    return { entries: [], stale: false, error: '还没有配置目录源：在工作流页「目录源」填入目录 JSON 地址并保存' }
  }
  const cacheFile = typeof cacheDir === 'string' && cacheDir.trim() !== '' ? cacheFilePath(cacheDir, url) : null
  // Fail-open even if readCache ever throws: a cache problem must never make
  // loadCatalog a throwing function (Review Focus #3).
  const cached = cacheFile === null ? null : await readCache(cacheFile).catch(() => null)
  if (cached !== null && nowMs - cached.cachedAt < ttl) {
    return { entries: cached.entries, stale: false, error: null }
  }
  try {
    const json = await fetchCatalogJson(url, fetchImpl, timeout)
    const { entries } = parseFormat1(json)
    let cacheWarning = null
    if (cacheFile !== null) {
      try {
        await writeCache(cacheFile, nowMs, url, entries)
      } catch (error) {
        cacheWarning = '目录已获取，但缓存写入失败：' + describeError(error)
      }
    }
    return { entries, stale: false, error: cacheWarning }
  } catch (error) {
    const reason =
      error instanceof CatalogFormatError
        ? '目录源格式不符：' + error.errors.join('；')
        : describeError(error)
    if (cached !== null) {
      return { entries: cached.entries, stale: true, error: '目录刷新失败，暂用过期缓存：' + reason }
    }
    return { entries: [], stale: false, error: '目录加载失败：' + reason }
  }
}

/** Lowercase/trim a catalog or capability string for containment matching. */
function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * One-way case-insensitive match (R-5A): the entry must offer the capability —
 * its name/title/description contains the capability id/title (equality counts).
 * Reverse is deliberately NOT matched: "research" must not absorb a "Search"
 * entry, which would recommend a plugin that does not cover the need.
 * @param {object} capability
 * @param {object} entry
 */
function capabilityMatchesEntry(capability, entry) {
  const wanted = [normalizeText(capability.id), normalizeText(capability.title)].filter((text) => text !== '')
  const offered = [normalizeText(entry.name), normalizeText(entry.title), normalizeText(entry.description)].filter(
    (text) => text !== '',
  )
  return wanted.some((capabilityText) => offered.some((entryText) => entryText.includes(capabilityText)))
}

/**
 * Build the stable, reproducible proposal id
 * `gap-<stageId>-<capId>-<entryName>`, normalized to letters/digits/dashes and
 * truncated with a sha256 suffix when it would grow past MAX_ID_LENGTH.
 * @param {unknown} stageId
 * @param {unknown} capabilityId
 * @param {string} entryName
 * @returns {string}
 */
function gapId(stageId, capabilityId, entryName) {
  const raw = 'gap-' + String(stageId) + '-' + String(capabilityId) + '-' + String(entryName)
  const slug = raw.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  const stable = slug === '' ? 'gap' : slug
  if (stable.length <= MAX_ID_LENGTH) return stable
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return stable.slice(0, MAX_ID_LENGTH - 9).replace(/-+$/g, '') + '-' + digest
}

/** Human-readable plugin label for a proposal title. */
function proposalTitle(entry) {
  const title = typeof entry.title === 'string' && entry.title !== '' ? entry.title : ''
  return title === '' || title === entry.name ? entry.name : title + '（' + entry.name + '）'
}

/** One human-readable sentence describing the gap this proposal fills. */
function gapEffect(stage, capability, entry) {
  const entryLabel = typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.name
  const stageTitle = typeof stage.title === 'string' && stage.title !== '' ? stage.title : String(stage.id)
  const capabilityTitle =
    typeof capability.title === 'string' && capability.title !== '' ? capability.title : String(capability.id)
  return '安装「' + entryLabel + '」（' + entry.name + '）以补齐阶段「' + stageTitle + '」中缺失的「' + capabilityTitle + '」能力。'
}

/**
 * Turn catalog matches for the map's *missing* capabilities into install
 * proposals (contract D7 Proposal[]).
 *
 * Rules: only `status: 'missing'` capabilities; skip entries already installed
 * per `scan.plugins` (case-insensitive); an entry matches only when its name,
 * title or description contains the capability id/title (case-insensitive,
 * one-way — equality counts, the reverse never matches); one proposal per
 * matching pair, in map order then catalog order; at most 20; deterministic ids;
 * empty/absent catalog.entries → [] (the caller reports the adapter error; no
 * fallback recommendations are invented). Pure: no disk, no model, no mutation.
 *
 * @param {{ scan?: object, map?: object, catalog?: { entries?: object[] } }} [input]
 */
export function matchGaps({ scan, map, catalog } = {}) {
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : []
  if (entries.length === 0) return []
  const installed = new Set()
  const pluginRows = Array.isArray(scan?.plugins) ? scan.plugins : []
  for (const plugin of pluginRows) {
    const name = normalizeText(plugin?.name)
    if (name !== '') installed.add(name)
  }
  const stages = Array.isArray(map?.stages) ? map.stages : []
  /** @type {Array<object>} */
  const proposals = []
  for (const stage of stages) {
    if (!isPlainObject(stage) || !Array.isArray(stage.capabilities)) continue
    for (const capability of stage.capabilities) {
      if (!isPlainObject(capability) || capability.status !== 'missing') continue
      for (const entry of entries) {
        if (!isPlainObject(entry) || typeof entry.name !== 'string' || entry.name === '') continue
        if (installed.has(normalizeText(entry.name))) continue
        if (!capabilityMatchesEntry(capability, entry)) continue
        proposals.push({
          id: gapId(stage.id, capability.id, entry.name),
          kind: 'install',
          title: proposalTitle(entry),
          effect: gapEffect(stage, capability, entry),
          evidence: { source: 'catalog', refs: [entry.name] },
        })
        if (proposals.length >= MAX_GAPS) return proposals
      }
    }
  }
  return proposals
}
