/**
 * Guizhi state store: the only place the plugin writes its own JSON state.
 *
 * Layout (design 8; the data root $DSH_HOME/guizhi is resolved by lib/index.js
 * and passed in as home):
 *   <home>/scan.json
 *   <home>/map.json
 *   <home>/proposals.json
 *   <home>/sources.json
 *   <home>/snapshots/<id>/   one copy of each existing state file + meta.json
 *
 * Two invariants keep a crash from corrupting state:
 * - every state write is temp file + rename in the same directory, so a reader
 *   sees either the old file or the new one, never a half-written one;
 * - a snapshot is a fresh directory whose meta.json is written last, so
 *   listSnapshots ignores a partially created snapshot.
 *
 * read() is deliberately forgiving: a missing file is { value: null, error: null }
 * (a first launch is not an error) and a corrupt JSON file is
 * { value: null, error }, never an exception. The caller decides whether to
 * rescan or surface the warning.
 *
 * @module @fanyingnie/dsh-guizhi/store
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** The only state documents this store owns (contract D7). */
const STATE_NAMES = Object.freeze(['scan', 'map', 'proposals', 'sources'])

/** File names a snapshot may hold; anything else in a meta.json is refused. */
const STATE_FILE_NAMES = new Set(STATE_NAMES.map((name) => name + '.json'))

/** Sub-directory of the data root that holds snapshots. */
const SNAPSHOTS_DIR = 'snapshots'

/** Per-snapshot metadata file, written after every state copy. */
const META_FILE = 'meta.json'

/** Single-file cap from the global constraints: 1 MB (exclusive). */
const MAX_STATE_FILE_BYTES = 1024 * 1024

/**
 * Snapshot ids are generated here, and any id read back from the API is checked
 * against this pattern before it becomes a path: letters, digits and dashes
 * only, so a traversal attempt cannot escape the snapshots directory.
 */
const SNAPSHOT_ID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/

/** Distinguishes the temp files of concurrent writers in this process. */
let tempSequence = 0

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Describe an unknown error without a stack. @param {unknown} error @returns {string} */
function describeError(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error)
  return text === '' ? 'unknown error' : text
}

/**
 * @typedef {object} ReadResult
 * @property {unknown} value Parsed JSON, or null when absent/corrupt.
 * @property {string | null} error Null when the file was absent or valid.
 */

/**
 * @typedef {object} SnapshotResult
 * @property {string} id
 * @property {string} tag
 * @property {string} createdAt ISO-8601
 * @property {string[]} files State file names copied into the snapshot.
 */

/**
 * @typedef {object} Store
 * @property {(name: string) => Promise<ReadResult>} read
 * @property {(name: string, value: unknown) => Promise<void>} write
 * @property {(tag?: string) => Promise<SnapshotResult>} snapshot
 * @property {(id: string) => Promise<{ restored: true }>} restore
 * @property {() => Promise<Array<{ id: string, tag: string, createdAt: string }>>} listSnapshots
 */

/**
 * Open the Guizhi state store rooted at home (the plugin passes
 * $DSH_HOME/guizhi; tests pass a tmpdir). The home directory itself is created
 * lazily on the first write or snapshot.
 * @param {{ home?: string }} [options]
 * @returns {Store}
 */
export function createStore(options) {
  const home = options?.home
  if (typeof home !== 'string' || home.trim() === '') {
    throw new TypeError('createStore 需要非空 home（数据根 $DSH_HOME/guizhi 由调用方传入）')
  }
  const homeDir = resolve(home)
  const snapshotsDir = join(homeDir, SNAPSHOTS_DIR)

  /**
   * Resolve one whitelisted state document to its absolute path; anything else
   * (pack files, traversal, typos) is refused before touching the disk.
   * @param {string} name
   * @returns {string}
   */
  function statePath(name) {
    if (!STATE_NAMES.includes(name)) {
      throw new TypeError('无效的状态名 "' + String(name) + '"：仅允许 ' + STATE_NAMES.join('/'))
    }
    return join(homeDir, name + '.json')
  }

  /**
   * Read a file as raw bytes; undefined when it does not exist.
   * @param {string} file
   * @returns {Promise<Buffer | undefined>}
   */
  async function readBytesIfExists(file) {
    try {
      return await readFile(file)
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * Write bytes atomically: private temp file beside the target, then rename.
   * A failed write removes its own temp file so no partial state is left behind.
   * @param {string} file
   * @param {string | Buffer} data
   * @returns {Promise<void>}
   */
  async function writeAtomic(file, data) {
    await mkdir(dirname(file), { recursive: true })
    tempSequence += 1
    const temp = file + '.' + process.pid + '.' + tempSequence + '.tmp'
    try {
      await writeFile(temp, data)
      await rename(temp, file)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Read one state document. Never throws for a missing or corrupt file.
   * @param {string} name
   * @returns {Promise<ReadResult>}
   */
  async function read(name) {
    const file = statePath(name)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { value: null, error: null }
      return { value: null, error: '读取状态 "' + name + '" 失败：' + describeError(error) }
    }
    try {
      return { value: JSON.parse(raw), error: null }
    } catch (error) {
      return { value: null, error: '状态 "' + name + '" 的 JSON 已损坏：' + describeError(error) }
    }
  }

  /**
   * Serialize and atomically replace one state document.
   * @param {string} name
   * @param {unknown} value
   * @returns {Promise<void>}
   */
  async function write(name, value) {
    const file = statePath(name)
    let text
    try {
      text = JSON.stringify(value, null, 2)
    } catch (error) {
      throw new TypeError('无法序列化状态 "' + name + '"：' + describeError(error))
    }
    if (typeof text !== 'string') {
      throw new TypeError('无法序列化状态 "' + name + '"：值不能是 undefined')
    }
    text += '\n'
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes >= MAX_STATE_FILE_BYTES) {
      throw new Error('状态 "' + name + '" 超过单文件 1MB 上限：' + bytes + ' 字节')
    }
    await writeAtomic(file, text)
  }

  /**
   * Copy every existing state file into a new snapshot directory and write its
   * meta.json last. Missing state files are simply not part of the snapshot.
   * @param {string} [tag]
   * @returns {Promise<SnapshotResult>}
   */
  async function snapshot(tag = 'manual') {
    if (typeof tag !== 'string') throw new TypeError('快照 tag 必须是字符串')
    await mkdir(homeDir, { recursive: true })
    await mkdir(snapshotsDir, { recursive: true })
    const createdAt = new Date().toISOString()
    const stamp = createdAt.replace(/[-:.]/g, '')
    let id = ''
    while (id === '') {
      tempSequence += 1
      const candidate = stamp + '-' + String(tempSequence).padStart(6, '0')
      try {
        await mkdir(join(snapshotsDir, candidate))
        id = candidate
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    const dir = join(snapshotsDir, id)
    const files = []
    try {
      for (const name of STATE_NAMES) {
        const file = name + '.json'
        const data = await readBytesIfExists(join(homeDir, file))
        if (data === undefined) continue
        await writeFile(join(dir, file), data)
        files.push(file)
      }
      files.sort()
      const meta = { id, tag, createdAt, files }
      await writeAtomic(join(dir, META_FILE), JSON.stringify(meta, null, 2) + '\n')
    } catch (error) {
      // meta.json is written last; without it the directory is not a snapshot,
      // so remove the half-built one instead of leaving junk behind.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return { id, tag, createdAt, files }
  }

  /**
   * Put a snapshot back. Idempotent by construction: a file whose bytes already
   * match the snapshot is not rewritten, so restoring twice is a no-op, and a
   * state file created after the snapshot is left untouched.
   * @param {string} id
   * @returns {Promise<{ restored: true }>}
   */
  async function restore(id) {
    if (typeof id !== 'string' || !SNAPSHOT_ID.test(id)) {
      throw new Error('无效的快照 id：' + String(id))
    }
    const dir = join(snapshotsDir, id)
    let meta
    try {
      meta = JSON.parse(await readFile(join(dir, META_FILE), 'utf8'))
    } catch {
      throw new Error('快照不存在或元数据已损坏：' + id)
    }
    // A snapshot whose meta.json parses but has the wrong shape is corrupted,
    // not empty: silently treating it as "no files" would report a fake success.
    if (!isPlainObject(meta)) {
      throw new Error('快照元数据已损坏：' + id + '（meta.json 不是对象）')
    }
    if (typeof meta.id !== 'string' || meta.id !== id) {
      throw new Error('快照元数据已损坏：' + id + '（meta.id 缺失、不是字符串或与目录名不一致）')
    }
    if (!Array.isArray(meta.files)) {
      throw new Error('快照元数据已损坏：' + id + '（files 必须是字符串数组）')
    }
    const files = meta.files
    for (const file of files) {
      if (typeof file !== 'string' || !STATE_FILE_NAMES.has(file)) {
        throw new Error('快照 ' + id + ' 含有非法状态文件：' + String(file))
      }
      let wanted
      try {
        wanted = await readFile(join(dir, file))
      } catch {
        throw new Error('快照 ' + id + ' 缺少文件：' + file)
      }
      const target = join(homeDir, file)
      const current = await readBytesIfExists(target)
      if (current !== undefined && current.equals(wanted)) continue
      await writeAtomic(target, wanted)
    }
    return { restored: true }
  }

  /**
   * List readable snapshots, newest first. A directory without a valid
   * meta.json (a crashed snapshot) is skipped instead of failing the listing.
   * @returns {Promise<Array<{ id: string, tag: string, createdAt: string }>>}
   */
  async function listSnapshots() {
    let entries
    try {
      entries = await readdir(snapshotsDir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const rows = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !SNAPSHOT_ID.test(entry.name)) continue
      let meta
      try {
        meta = JSON.parse(await readFile(join(snapshotsDir, entry.name, META_FILE), 'utf8'))
      } catch {
        continue
      }
      if (typeof meta?.tag !== 'string' || typeof meta?.createdAt !== 'string') continue
      rows.push({ id: entry.name, tag: meta.tag, createdAt: meta.createdAt })
    }
    rows.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
    return rows
  }

  return { read, write, snapshot, restore, listSnapshots }
}
