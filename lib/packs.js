/**
 * Packs: build, validate and export capability packs (contract D7).
 *
 * A pack is the portable declaration of one workflow assembly:
 *   { version: 1, id, title, createdAt, stageIds: string[], rows: [],
 *     tools: string[], skills: string[], items: [],
 *     requirements: { appliesAt: 'new-session', ownSession: false } }
 *
 * rows and items stay empty on purpose in v1: capability evidence is assembled
 * by callers further up the stack, and this module never invents it.
 * tools / skills are the ordered, de-duplicated union of the selected stages'
 * declared names.
 *
 * Division of labour:
 * - buildPack is pure: no disk, no host service, no model call. It validates
 *   its own result through validatePack before returning, so an illegal pack
 *   cannot reach the store or the HTTP routes unnoticed.
 * - validatePack *is* schemas.pack.validate, the authoritative D7 checker;
 *   this module does not copy or tighten its shape rules (D9).
 * - exportPack is the only function here that touches the disk. It validates
 *   first, writes <home>/packs/<id>.json atomically (temp file + rename) and
 *   returns the absolute path. home is passed in by the caller (data root
 *   $DSH_HOME/guizhi, D16); nothing in this module reads the environment.
 *
 * @module @fanyingnie/dsh-guizhi/packs
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { schemas } from './schemas.js'

/** Sub-directory of the data root that holds exported packs. */
const PACKS_DIR = 'packs'

/** Single-file cap from the global constraints: 1 MB (exclusive). */
const MAX_PACK_FILE_BYTES = 1024 * 1024

/** Fixed requirements default (D7): effective in a new session, no own session. */
const DEFAULT_REQUIREMENTS = Object.freeze({ appliesAt: 'new-session', ownSession: false })

/** Distinguishes the temp files of concurrent writers in this process. */
let tempSequence = 0

/**
 * Validate one pack document against the D7 contract.
 *
 * This is the exact schemas.pack.validate function reference — importing the
 * authoritative checker instead of copying its shape rules (D9). It returns
 * { ok, errors }, is total (never throws) and rejects unknown fields.
 * @type {(value: unknown) => { ok: boolean, errors: string[] }}
 */
export const validatePack = schemas.pack.validate

/**
 * Build the Error exportPack throws for an illegal pack. .errors carries the
 * schema's readable field paths so routes can answer 400 with details.
 * @param {string[]} errors
 * @returns {Error & { errors: string[] }}
 */
function packValidationError(errors) {
  const error = new Error('能力包校验失败：' + errors.join('；'))
  error.name = 'PackValidationError'
  error.errors = errors
  return error
}

/**
 * Build the Error buildPack throws for unusable input (missing stage, bad
 * list, ...). The message is meant to be shown to the user as-is.
 * @param {string} message
 * @returns {Error}
 */
function packBuildError(message) {
  const error = new Error(message)
  error.name = 'PackBuildError'
  return error
}

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
 * Read one stage's tools/skills list.
 *
 * An absent field means "this stage declares none" (a D7 map stage carries no
 * tools/skills yet); anything malformed throws instead of being silently
 * dropped, so a pack never quietly loses a capability name.
 * @param {unknown} value
 * @param {string} label Readable field name used in the error message.
 * @returns {string[]}
 */
function readNameList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw packBuildError('buildPack：' + label + ' 必须是字符串数组')
  for (const entry of value) {
    if (typeof entry !== 'string') throw packBuildError('buildPack：' + label + ' 必须是字符串数组')
  }
  return value
}

/**
 * Append names that were not seen before, preserving first-seen order.
 * @param {string[]} target
 * @param {Set<string>} seen
 * @param {Iterable<string>} names
 * @returns {void}
 */
function mergeNames(target, seen, names) {
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    target.push(name)
  }
}

/**
 * Assemble a D7 pack from a workflow map plus an ordered stage selection.
 *
 * Stages are looked up in map.stages by id and merged in stageIds order;
 * tools/skills are de-duplicated and keep their first-seen order. A stageIds
 * entry that names no stage is an error, never a silent skip. rows and items
 * are always [] in v1 (evidence belongs to the caller); requirements are the
 * fixed D7 default. The id is deterministic:
 * 'pack-' + sha256(JSON.stringify({ title, stageIds })).slice(0, 8), so the
 * same title + stage selection always yields the same file name (preview and
 * rollback can reconcile by id), while createdAt still records the build.
 *
 * @param {{ map?: unknown, stageIds?: unknown, title?: unknown }} [input]
 * @returns {object}
 * @throws {Error} name is 'PackBuildError' for unusable input,
 *   'PackValidationError' in the defensive final check
 */
export function buildPack(input) {
  const source = isPlainObject(input) ? input : {}
  const { map, stageIds, title } = source
  if (!isPlainObject(map) || !Array.isArray(map.stages)) {
    throw packBuildError('buildPack 需要包含 stages 数组的 map')
  }
  if (!Array.isArray(stageIds)) throw packBuildError('buildPack 需要字符串数组 stageIds')
  if (typeof title !== 'string') throw packBuildError('buildPack 需要字符串 title')

  /** The pack owns its copy, so mutating the caller's array cannot drift it. */
  const selected = []
  for (const [index, id] of stageIds.entries()) {
    if (typeof id !== 'string') throw packBuildError('buildPack：stageIds[' + index + '] 必须是字符串')
    selected.push(id)
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const stagesById = new Map()
  for (const [index, stage] of map.stages.entries()) {
    if (!isPlainObject(stage) || typeof stage.id !== 'string') {
      throw packBuildError('buildPack：map.stages[' + index + '] 必须是带字符串 id 的对象')
    }
    stagesById.set(stage.id, stage)
  }

  const chosen = []
  for (const id of selected) {
    const stage = stagesById.get(id)
    if (stage === undefined) {
      const available = [...stagesById.keys()]
      throw packBuildError(
        'buildPack：stageIds 引用的阶段 ' + JSON.stringify(id) + ' 不存在于地图中' +
          '（可用阶段：' + (available.length > 0 ? available.join(', ') : '无') + '）',
      )
    }
    chosen.push(stage)
  }

  const tools = []
  const skills = []
  const seenTools = new Set()
  const seenSkills = new Set()
  for (const stage of chosen) {
    const stageLabel = '阶段 ' + JSON.stringify(stage.id)
    mergeNames(tools, seenTools, readNameList(stage.tools, stageLabel + ' 的 tools'))
    mergeNames(skills, seenSkills, readNameList(stage.skills, stageLabel + ' 的 skills'))
  }

  const pack = {
    version: 1,
    id: 'pack-' + createHash('sha256').update(JSON.stringify({ title, stageIds: selected })).digest('hex').slice(0, 8),
    title,
    createdAt: new Date().toISOString(),
    stageIds: selected,
    rows: [],
    tools,
    skills,
    items: [],
    requirements: { appliesAt: DEFAULT_REQUIREMENTS.appliesAt, ownSession: DEFAULT_REQUIREMENTS.ownSession },
  }
  const result = validatePack(pack)
  if (!result.ok) throw packValidationError(result.errors)
  return pack
}

/**
 * Resolve the pack id to a file name confined to the packs directory.
 * schemas.pack only requires a string id, so the filesystem boundary is
 * enforced here: an id containing a separator (or equal to "." or "..") could
 * otherwise leave <home>/packs.
 * @param {string} id
 * @returns {string}
 */
function packFileName(id) {
  const unsafe = id === '' || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('\0')
  if (unsafe) throw new TypeError('能力包 id 不能作为合法文件名：' + JSON.stringify(id))
  return id + '.json'
}

/**
 * Write bytes atomically: private temp file beside the target, then rename.
 * A failed write removes its own temp file so no partial pack is left behind.
 * @param {string} file
 * @param {string} data
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
 * Validate a pack and export it to <home>/packs/<id>.json.
 *
 * Validation always comes first: an illegal pack is refused before the target
 * directory is even created. The file is written as pretty JSON with a
 * trailing newline, temp file + rename, and is subject to the same 1 MB
 * single-file cap as the rest of the Guizhi data root. The home directory
 * (and its packs/ sub-directory) is created when missing.
 *
 * @param {{ home?: unknown, pack?: unknown }} [input]
 * @returns {Promise<{ path: string }>} Absolute path of the written file.
 * @throws {TypeError} invalid home, unsafe pack id or unserializable pack
 * @throws {Error & { errors: string[] }} name is 'PackValidationError' for an illegal pack
 */
export async function exportPack(input) {
  const source = isPlainObject(input) ? input : {}
  const { home, pack } = source
  const result = validatePack(pack)
  if (!result.ok) throw packValidationError(result.errors)
  if (typeof home !== 'string' || home.trim() === '') {
    throw new TypeError('exportPack 需要非空 home（数据根 $DSH_HOME/guizhi 由调用方传入）')
  }
  const file = join(resolve(home), PACKS_DIR, packFileName(pack.id))
  let text
  try {
    text = JSON.stringify(pack, null, 2)
  } catch (error) {
    throw new TypeError('无法序列化能力包 ' + JSON.stringify(pack.id) + '：' + describeError(error))
  }
  text += '\n'
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes >= MAX_PACK_FILE_BYTES) {
    throw new Error('能力包 ' + JSON.stringify(pack.id) + ' 超过单文件 1MB 上限：' + bytes + ' 字节')
  }
  await writeAtomic(file, text)
  return { path: file }
}
