/**
 * Static tool-owner attribution for installed npm plugins (T2.5 / D8).
 *
 * The host tools service exposes name/description only (no registration owner;
 * see docs/host-notes.md and D8), so this layer reads the installed packages
 * under <profilePath>/node_modules and looks for a real tool-name match in
 * their JavaScript sources. It never guesses from a package name: a tool is
 * owned by a plugin only when the plugin source contains the tool name inside a
 * registration shape (name: 'tool' / defineTool({ name: 'tool' }) /
 * register(defineTool({ name: 'tool' })) / a name literal near a register call).
 *
 * Output contract for lib/scan.js: rows are the input tool rows, one row per
 * (tool, matching plugin) pair with owner = package name, plus one ownerless row
 * for every tool no npm source matched. scan merges owners by tool name, so a
 * tool registered by N plugins arrives as N same-name rows.
 *
 * Safety: read-only. Only package.json and .js/.mjs/.cjs files are read; the
 * manifest is size-checked before reading and test/fixture paths are skipped
 * (test/, tests/, __tests__/, fixtures/, *.test.*, *.spec.*). Nested
 * node_modules and symlinked entries discovered inside a package are skipped,
 * but a plugin root that is itself a symlink (pnpm layout) is followed by
 * design: without that exemption the real profile cannot be attributed.
 * Per-plugin scanning is bounded to 200 files and 1 MB total, and every read
 * failure degrades to a bounded, deduplicated warning. profilePath may be
 * empty - rows come back ownerless with a warning instead of throwing. This
 * module never imports '@deepseek-ai/dsh-tools' (D11), never writes, and never
 * calls a model or the network.
 *
 * Heuristic limits (documented for review): a tool name held in a variable and
 * registered outside a local registration call, or built at runtime (e.g. by a
 * prefix helper), is not attributed; those tools stay ownerless with the
 * aggregate warning. Local registration wrappers are recognised when a
 * same-file function/arrow body calls a registration primitive (aliases are
 * traced transitively); a bare object with name/description keys is never
 * enough evidence on its own. The static match is evidence of a source-level
 * registration, not a runtime guarantee.
 *
 * @module @fanyingnie/dsh-guizhi/attribution
 */
import { readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { describeError } from './host.js'

/** Per-plugin scan caps pinned by the T2.5 contract. */
const MAX_SCAN_FILES = 200
const MAX_SCAN_BYTES = 1024 * 1024

/** Directory entries examined before a walk is treated as truncated. */
const MAX_WALK_ENTRIES = 5000

/** Only these source extensions are considered; package.json is read first. */
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
const MANIFEST_NAME = 'package.json'
const NESTED_MODULES = 'node_modules'

/** Directories never scanned: their registrations are tests, not runtime tools. */
const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'fixtures'])

/** Files never scanned (besides package.json): per-file test/spec sources. */
const TEST_FILE_PATTERN = /\.(?:test|spec)\./i

/** Warning bounds: one message never grows unbounded. */
const MAX_WARNING_NAMES = 20
const MAX_WARNING_CHARS = 500

/** How far before a quoted tool name a registration anchor may sit. */
const ANCHOR_WINDOW = 240

/**
 * Tool-definition keys that prove a quoted name is a tool definition rather
 * than sample/test data (e.g. a session-event fixture with a name field).
 */
const TOOL_DEFINITION_SIGNAL = /\b(?:description|execute|parameters|output|isConcurrencySafe)\s*[:(]/

/** How far around a name literal its tool-definition keys may sit. */
const SIGNAL_WINDOW = 400

/** A quoted tool-name literal as the value of a name: key. */
const NAME_KEY_SUFFIX = /(?:^|[^A-Za-z0-9_$])name\s*:\s*$/

/** Registration primitives; aliases of these are traced per source file. */
const ANCHOR_CALLEES = new Set(['defineTool', 'registerTool', 'register'])

/** How far into a candidate wrapper body an anchor call is looked for. */
const ALIAS_BODY_WINDOW = 600

/** Fixed-point passes when tracing registration-wrapper aliases. */
const ALIAS_MAX_PASSES = 6

/** Characters that can appear in a dotted callee (peeled backwards). */
const CALLEE_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$.')

/** Characters treated as whitespace while peeling a call expression. */
const WHITESPACE_CHARS = new Set([' ', '\t', '\n', '\r'])

/** Arrow-function/const definition whose body may wrap a registration call. */
const ARROW_DEFINITION_PATTERN = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g

/** Function declaration whose body may wrap a registration call. */
const FUNCTION_DEFINITION_PATTERN = /function\s+([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g

/** One call expression's dotted callee, for anchor recognition. */
const CALL_PATTERN = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g

/**
 * A quoted literal skeleton; the tool-name alternation is substituted for
 * __TOOL_NAME__ and the quote capture/backreference keeps the literal bounded.
 */
const NAME_SKELETON = /(['"])(__TOOL_NAME__)\1/g

/** RegExp metacharacters escaped by escapeRegExp (names match literally). */
const REGEX_SPECIALS = new Set('\\^$.*+?()[]{}|')

/** Default readers; tests may inject a subset through io. */
const DEFAULT_IO = { readFile: fsReadFile, readdir: fsReaddir, stat: fsStat }

/**
 * @typedef {object} AttributionRow
 * @property {string} name
 * @property {string} description
 * @property {string} [owner] npm package name; omitted when unattributed.
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bound one warning message to a single readable line. @param {string} text */
function boundWarning(text) {
  return text.length <= MAX_WARNING_CHARS ? text : text.slice(0, MAX_WARNING_CHARS - 1) + '…'
}

/** @param {string[]} messages @returns {string[]} bounded and deduplicated, order kept. */
function finalizeWarnings(messages) {
  const seen = new Set()
  const out = []
  for (const message of messages) {
    if (typeof message !== 'string' || message === '') continue
    const bounded = boundWarning(message)
    if (seen.has(bounded)) continue
    seen.add(bounded)
    out.push(bounded)
  }
  return out
}

/** Escape one literal for a RegExp constructor. @param {unknown} value */
function escapeRegExp(value) {
  const text = String(value)
  let out = ''
  for (const char of text) out += REGEX_SPECIALS.has(char) ? '\\' + char : char
  return out
}

/**
 * Split an npm package name into path segments after refusing anything that
 * could escape <profilePath>/node_modules (traversal, absolute paths). A scoped
 * package is exactly two segments and its first segment starts with @.
 * @param {unknown} name
 * @returns {string[] | null}
 */
function packageSegments(name) {
  if (typeof name !== 'string' || name === '') return null
  const parts = name.split('/')
  if (parts.length > 2) return null
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (index === 0 && parts.length === 2) {
      if (!/^@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) return null
      continue
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part.includes('..')) return null
  }
  return parts
}

/**
 * Read one file as text regardless of the reader returning a string or Buffer.
 * @param {{ readFile: Function }} io
 * @param {string} file
 * @returns {Promise<string>}
 */
async function readText(io, file) {
  const raw = await io.readFile(file, 'utf8')
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  return String(raw)
}

/** @param {{ stat: Function }} io @param {string} file @returns {Promise<number>} */
async function fileSize(io, file) {
  const info = await io.stat(file)
  if (!isRecord(info) || typeof info.size !== 'number' || !Number.isFinite(info.size) || info.size < 0) {
    throw new Error('无法读取文件大小')
  }
  return info.size
}

/**
 * Normalize host.listTools() rows: a row without a non-empty name cannot be
 * attributed or represented, so it is skipped and counted once.
 * @param {unknown} tools
 * @param {string[]} warnings
 * @returns {{ name: string, description: string }[]}
 */
function normalizeTools(tools, warnings) {
  const rows = []
  if (tools === undefined || tools === null) return rows
  if (!Array.isArray(tools)) {
    warnings.push('tools 不是数组：按空工具清单处理')
    return rows
  }
  let invalid = 0
  for (const row of tools) {
    const name = isRecord(row) && typeof row.name === 'string' ? row.name : ''
    if (name === '') {
      invalid += 1
      continue
    }
    rows.push({ name, description: isRecord(row) && typeof row.description === 'string' ? row.description : '' })
  }
  if (invalid > 0) warnings.push('忽略 ' + invalid + ' 条无效工具行（缺少 name）')
  return rows
}

/**
 * Collect the npm plugin rows that can be statically scanned. Patch plugins
 * have no install directory in the profile (their sources live elsewhere), so
 * they are never attributed. Invalid or duplicate names are skipped.
 * @param {unknown} plugins
 * @param {string[]} warnings
 * @returns {{ name: string, segments: string[] }[]}
 */
function collectNpmPlugins(plugins, warnings) {
  const out = []
  if (plugins === undefined || plugins === null) return out
  if (!Array.isArray(plugins)) {
    warnings.push('plugins 不是数组：按空插件清单处理')
    return out
  }
  const seen = new Set()
  for (const row of plugins) {
    if (!isRecord(row) || typeof row.name !== 'string' || row.name === '') continue
    if (row.source !== 'npm') continue
    if (seen.has(row.name)) continue
    const segments = packageSegments(row.name)
    if (segments === null) {
      warnings.push('跳过非法插件名：' + row.name.slice(0, 80))
      continue
    }
    seen.add(row.name)
    out.push({ name: row.name, segments })
  }
  return out
}

/**
 * Walk one plugin directory for .js/.mjs/.cjs candidates. Test/fixture paths
 * are skipped, symlinked entries are never followed and nested node_modules is
 * never entered. Collects at most maxFiles+1 candidates: an extra candidate is
 * the proof that the file cap truncated the scan (exactly maxFiles is not
 * truncation). Directory traversal has its own separate safety cap.
 * @param {string} root
 * @param {{ readdir: Function }} io
 * @param {number} maxFiles
 * @returns {Promise<{ files: string[], fileLimitHit: boolean, walkLimited: boolean, unreadableDirs: string[] }>}
 */
async function collectSourceFiles(root, io, maxFiles) {
  /** @type {string[]} */
  const files = []
  /** @type {string[]} */
  const queue = ['']
  /** @type {string[]} */
  const unreadableDirs = []
  let entriesSeen = 0
  let fileLimitHit = false
  let walkLimited = false
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const relativeDir = queue[cursor]
    const absoluteDir = relativeDir === '' ? root : join(root, ...relativeDir.split('/'))
    let entries
    try {
      entries = await io.readdir(absoluteDir, { withFileTypes: true })
    } catch (error) {
      if (relativeDir === '') throw error
      unreadableDirs.push(relativeDir)
      continue
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      entriesSeen += 1
      if (entriesSeen > MAX_WALK_ENTRIES) {
        walkLimited = true
        break
      }
      if (typeof entry?.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue
      const childRelative = relativeDir === '' ? entry.name : relativeDir + '/' + entry.name
      if (typeof entry?.isDirectory === 'function' && entry.isDirectory()) {
        const dirName = entry.name.toLowerCase()
        if (dirName === NESTED_MODULES || TEST_DIRECTORIES.has(dirName)) continue
        queue.push(childRelative)
        continue
      }
      if (typeof entry?.isFile !== 'function' || !entry.isFile()) continue
      if (TEST_FILE_PATTERN.test(entry.name)) continue
      if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      files.push(childRelative)
      if (files.length > maxFiles) {
        files.pop()
        fileLimitHit = true
        break
      }
    }
    if (walkLimited || fileLimitHit) break
  }
  return { files, fileLimitHit, walkLimited, unreadableDirs }
}

/** Trim trailing ASCII whitespace. @param {string} text */
function trimEndWhitespace(text) {
  let index = text.length - 1
  while (index >= 0 && WHITESPACE_CHARS.has(text[index])) index -= 1
  return text.slice(0, index + 1)
}

/**
 * Whether a dotted callee is a registration anchor: a primitive bare call
 * (defineTool / registerTool / register), the tools.register method, or a
 * same-file wrapper alias.
 * @param {string[]} tokens
 * @param {Set<string>} aliases
 */
function isAnchorCallee(tokens, aliases) {
  if (tokens.length === 0) return false
  const last = tokens[tokens.length - 1]
  if (tokens.length === 1) return aliases.has(last)
  return last === 'register' && tokens[tokens.length - 2] === 'tools'
}

/**
 * Peel one call expression from the end of text (a dotted callee immediately
 * followed by an opening parenthesis) and say whether it is an anchor call.
 * @param {string} text
 * @param {Set<string>} aliases
 */
function peelAnchorCall(text, aliases) {
  let rest = trimEndWhitespace(text)
  if (!rest.endsWith('(')) return false
  rest = trimEndWhitespace(rest.slice(0, -1))
  let index = rest.length - 1
  while (index >= 0 && CALLEE_CHARS.has(rest[index])) index -= 1
  const callee = rest.slice(index + 1)
  if (callee === '') return false
  return isAnchorCallee(callee.split('.'), aliases)
}

/**
 * Whether text before a name: key shows a tool definition object passed
 * directly to a registration call (reg({...}) / tools.register(defineTool({...}))).
 * @param {string} tail
 * @param {Set<string>} aliases
 */
function objectArgumentHasRegistration(tail, aliases) {
  const trimmed = trimEndWhitespace(tail)
  const nameKey = NAME_KEY_SUFFIX.exec(trimmed)
  if (nameKey === null) return false
  // Drop the name: key itself; the remaining prefix must end with the object's
  // opening brace directly after a registration call, e.g. reg(t({ or
  // ctx.tools.register(defineTool({. Non-first keys are covered by the fallback.
  const prefix = trimEndWhitespace(trimmed.slice(0, nameKey.index))
  if (!prefix.endsWith('{')) return false
  return peelAnchorCall(prefix.slice(0, -1), aliases)
}

/**
 * Call names a file treats as registration calls: the primitives plus local
 * wrapper functions/arrows whose body calls a primitive or another alias.
 * @param {string} text
 * @returns {Set<string>}
 */
function registrationAnchorNames(text) {
  const aliases = new Set(ANCHOR_CALLEES)
  const definitions = []
  ARROW_DEFINITION_PATTERN.lastIndex = 0
  let match
  while ((match = ARROW_DEFINITION_PATTERN.exec(text)) !== null) {
    definitions.push({ name: match[1], bodyStart: match.index + match[0].length })
  }
  FUNCTION_DEFINITION_PATTERN.lastIndex = 0
  while ((match = FUNCTION_DEFINITION_PATTERN.exec(text)) !== null) {
    definitions.push({ name: match[1], bodyStart: match.index + match[0].length })
  }
  for (let pass = 0; pass < ALIAS_MAX_PASSES; pass += 1) {
    let added = false
    for (const definition of definitions) {
      if (aliases.has(definition.name)) continue
      const body = text.slice(definition.bodyStart, definition.bodyStart + ALIAS_BODY_WINDOW)
      if (!bodyHasAnchorCall(body, aliases)) continue
      aliases.add(definition.name)
      added = true
    }
    if (!added) break
  }
  return aliases
}

/**
 * Whether a wrapper body window contains a call to a known anchor.
 * @param {string} body
 * @param {Set<string>} aliases
 */
function bodyHasAnchorCall(body, aliases) {
  CALL_PATTERN.lastIndex = 0
  let match
  while ((match = CALL_PATTERN.exec(body)) !== null) {
    if (isAnchorCallee(match[1].split('.'), aliases)) return true
  }
  return false
}

/**
 * Whether a registration call anchor sits near one literal (name-not-first
 * object fallback: definition keys plus a nearby real registration call).
 * @param {string} text
 * @param {number} index
 * @param {Set<string>} aliases
 */
function hasAnchorNear(text, index, aliases) {
  const start = Math.max(0, index - ANCHOR_WINDOW)
  const window = text.slice(start, Math.min(text.length, index + SIGNAL_WINDOW))
  CALL_PATTERN.lastIndex = 0
  let match
  while ((match = CALL_PATTERN.exec(window)) !== null) {
    if (isAnchorCallee(match[1].split('.'), aliases)) return true
  }
  return false
}

/**
 * Build the per-file matcher for the known tool names. Literals are matched
 * only as complete quoted strings, so a name merely mentioned in prose is not
 * attributed.
 * @param {string[]} toolNames
 * @returns {RegExp | null}
 */
function toolLiteralPattern(toolNames) {
  if (toolNames.length === 0) return null
  const alternation = toolNames.map(escapeRegExp).join('|')
  return new RegExp(NAME_SKELETON.source.replace('__TOOL_NAME__', () => alternation), 'g')
}

/**
 * Tool names this one source file registers. A quoted literal counts only when
 * it is the value of a name: key or sits near a registration anchor.
 * @param {string} text
 * @param {RegExp} pattern fresh lastIndex per call
 * @returns {Set<string>}
 */
function registeredNamesIn(text, pattern) {
  const matched = new Set()
  const aliases = registrationAnchorNames(text)
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    const name = match[2]
    const before = text.slice(Math.max(0, match.index - ANCHOR_WINDOW), match.index)
    if (NAME_KEY_SUFFIX.test(before)) {
      // A name: key is also used by sample/test data. It only counts when the
      // object is passed straight to a registration call, or when tool-definition
      // keys sit next to a real registration anchor.
      if (objectArgumentHasRegistration(before, aliases)) {
        matched.add(name)
        continue
      }
      if (hasDefinitionSignal(text, match.index) && hasAnchorNear(text, match.index, aliases)) matched.add(name)
      continue
    }
    // A quoted literal passed directly to a registration call, e.g. register('x').
    if (peelAnchorCall(before, aliases)) matched.add(name)
  }
  return matched
}

/**
 * Whether a tool-definition key sits near one name literal.
 * @param {string} text
 * @param {number} index
 */
function hasDefinitionSignal(text, index) {
  const start = Math.max(0, index - SIGNAL_WINDOW)
  return TOOL_DEFINITION_SIGNAL.test(text.slice(start, index + SIGNAL_WINDOW))
}

/**
 * Scan one npm plugin's installed directory for the tool names its source
 * registers. Throws only when the package manifest cannot be read/parsed (the
 * caller turns that into a warning); per-source-file failures stay warnings.
 * @param {{ name: string, segments: string[] }} plugin
 * @param {string} profilePath
 * @param {string[]} toolNames
 * @param {{ readFile: Function, readdir: Function, stat: Function }} io
 * @param {string[]} warnings
 * @returns {Promise<Set<string>>}
 */
/** One bounded scan-cap warning reused by the manifest precheck and source scan. @param {string} pluginName */
function truncationWarning(pluginName) {
  return '插件 ' + pluginName + ' 源码扫描超过上限（最多 ' + MAX_SCAN_FILES + ' 个文件 / 1MB），已截断'
}

/**
 * Scan one npm plugin's installed directory for the tool names its source
 * registers. The manifest is stat-checked before it is read (it is the only
 * otherwise-unbounded read). Throws only when the manifest cannot be
 * read/parsed (the caller turns that into a warning); per-source-file failures
 * stay warnings.
 * @param {{ name: string, segments: string[] }} plugin
 * @param {string} profilePath
 * @param {string[]} toolNames
 * @param {{ readFile: Function, readdir: Function, stat: Function }} io
 * @param {string[]} warnings
 * @returns {Promise<Set<string>>}
 */
async function scanPlugin(plugin, profilePath, toolNames, io, warnings) {
  const root = join(profilePath, NESTED_MODULES, ...plugin.segments)
  const pattern = toolLiteralPattern(toolNames)
  const matched = new Set()
  if (pattern === null) return matched
  const manifestPath = join(root, MANIFEST_NAME)
  let manifestSize
  try {
    manifestSize = await fileSize(io, manifestPath)
  } catch (error) {
    throw new Error('读取 ' + MANIFEST_NAME + ' 失败：' + describeError(error))
  }
  if (manifestSize > MAX_SCAN_BYTES) {
    warnings.push(truncationWarning(plugin.name))
    return matched
  }
  let manifestText
  try {
    manifestText = await readText(io, manifestPath)
  } catch (error) {
    throw new Error('读取 ' + MANIFEST_NAME + ' 失败：' + describeError(error))
  }
  const manifestBytes = Buffer.byteLength(manifestText, 'utf8')
  if (manifestBytes > MAX_SCAN_BYTES) {
    warnings.push(truncationWarning(plugin.name))
    return matched
  }
  try {
    JSON.parse(manifestText)
  } catch (error) {
    throw new Error(MANIFEST_NAME + ' 无法解析：' + describeError(error))
  }

  const walked = await collectSourceFiles(root, io, MAX_SCAN_FILES - 1)
  const failures = []
  let truncated = walked.fileLimitHit
  let bytesRead = manifestBytes
  for (const relative of walked.files) {
    const file = join(root, ...relative.split('/'))
    let size
    try {
      size = await fileSize(io, file)
    } catch (error) {
      failures.push({ relative, reason: describeError(error) })
      continue
    }
    if (bytesRead + size > MAX_SCAN_BYTES) {
      truncated = true
      continue
    }
    let text
    try {
      text = await readText(io, file)
    } catch (error) {
      failures.push({ relative, reason: describeError(error) })
      continue
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytesRead + bytes > MAX_SCAN_BYTES) {
      truncated = true
      continue
    }
    bytesRead += bytes
    for (const name of registeredNamesIn(text, pattern)) matched.add(name)
  }
  if (walked.walkLimited) {
    warnings.push('插件 ' + plugin.name + ' 目录条目超过安全上限（' + MAX_WALK_ENTRIES + ' 个），扫描已中止')
  }
  if (walked.unreadableDirs.length > 0) {
    warnings.push(
      '读取插件 ' + plugin.name + ' 的目录失败（' + walked.unreadableDirs.length + ' 个）：' + walked.unreadableDirs[0],
    )
  }
  if (truncated) warnings.push(truncationWarning(plugin.name))
  if (failures.length > 0) {
    const first = failures[0]
    warnings.push(
      '读取插件 ' + plugin.name + ' 的文件失败（' + failures.length + ' 个）：' + first.relative + '：' + first.reason,
    )
  }
  return matched
}

/**
 * One bounded aggregate warning naming the tools no npm source matched.
 * @param {string[]} names
 */
function unattributedWarning(names) {
  const shown = names.slice(0, MAX_WARNING_NAMES).join(', ')
  const suffix = names.length > MAX_WARNING_NAMES ? ' 等 ' + names.length + ' 个' : ''
  return '以下工具无法归因到插件：' + shown + suffix
}

/**
 * Resolve the profile's node_modules directory, or return null with a warning.
 * @param {string} profilePath
 * @param {{ stat: Function }} io
 * @param {string[]} warnings
 * @returns {Promise<boolean>} whether the profile can be scanned
 */
async function profileScannable(profilePath, io, warnings) {
  if (profilePath === '') {
    warnings.push('profile 路径为空：无法静态归因工具来源')
    return false
  }
  try {
    const info = await io.stat(profilePath)
    if (!isRecord(info) || (typeof info.isDirectory === 'function' && info.isDirectory() === false)) {
      warnings.push('profile 路径不是目录：' + profilePath + '（无法静态归因工具来源）')
      return false
    }
  } catch (error) {
    warnings.push('profile 目录不可用：' + profilePath + '：' + describeError(error) + '（无法静态归因工具来源）')
    return false
  }
  const modulesDir = join(profilePath, NESTED_MODULES)
  try {
    const info = await io.stat(modulesDir)
    if (!isRecord(info) || (typeof info.isDirectory === 'function' && info.isDirectory() === false)) {
      warnings.push('profile 缺少可读的 node_modules：' + modulesDir + '（无法静态归因工具来源）')
      return false
    }
  } catch (error) {
    warnings.push('profile 缺少可读的 node_modules：' + modulesDir + '：' + describeError(error) + '（无法静态归因工具来源）')
    return false
  }
  return true
}

/**
 * Statically attribute host tool rows to installed npm plugins.
 *
 * Never throws: an unusable profile, unreadable plugin or missing package.json
 * degrades to (ownerless rows +) warnings. io is an optional reader injection
 * for tests (readFile / readdir / stat); production uses node:fs/promises.
 *
 * @param {{
 *   tools?: unknown,
 *   plugins?: unknown,
 *   profilePath?: unknown,
 *   io?: { readFile?: Function, readdir?: Function, stat?: Function },
 * }} [input]
 * @returns {Promise<{ rows: AttributionRow[], warnings: string[] }>}
 */
export async function attributeTools(input = {}) {
  const warnings = []
  const tools = normalizeTools(input?.tools, warnings)
  const ownerlessRows = tools.map((row) => ({ name: row.name, description: row.description }))
  const profilePath = typeof input?.profilePath === 'string' ? input.profilePath : ''
  const io = { ...DEFAULT_IO }
  if (isRecord(input?.io)) {
    for (const key of ['readFile', 'readdir', 'stat']) {
      if (typeof input.io[key] === 'function') io[key] = input.io[key]
    }
  }
  const plugins = collectNpmPlugins(input?.plugins, warnings)
  const scannable = await profileScannable(profilePath, io, warnings)
  if (!scannable) return { rows: ownerlessRows, warnings: finalizeWarnings(warnings) }

  const toolNames = [...new Set(tools.map((row) => row.name))]
  /** @type {Map<string, string[]>} */
  const ownersByName = new Map()
  for (const plugin of plugins) {
    let matched
    try {
      matched = await scanPlugin(plugin, profilePath, toolNames, io, warnings)
    } catch (error) {
      warnings.push('读取插件 ' + plugin.name + ' 失败：' + describeError(error))
      continue
    }
    for (const name of matched) {
      const owners = ownersByName.get(name)
      if (owners === undefined) ownersByName.set(name, [plugin.name])
      else if (!owners.includes(plugin.name)) owners.push(plugin.name)
    }
  }

  if (plugins.length === 0 && tools.length > 0) {
    warnings.push('插件清单里没有 source=npm 的插件：工具行保持无 owner')
  }
  const rows = []
  const unattributed = []
  const seenUnattributed = new Set()
  for (const tool of tools) {
    const owners = ownersByName.get(tool.name) ?? []
    if (owners.length === 0) {
      rows.push({ name: tool.name, description: tool.description })
      if (!seenUnattributed.has(tool.name)) {
        seenUnattributed.add(tool.name)
        unattributed.push(tool.name)
      }
      continue
    }
    for (const owner of owners) rows.push({ name: tool.name, description: tool.description, owner })
  }
  if (unattributed.length > 0) warnings.push(unattributedWarning(unattributed))
  return { rows, warnings: finalizeWarnings(warnings) }
}

/** @param {unknown} value @returns {string[]} filtered string warnings from a snapshot */
function warningSnapshot(value) {
  return Array.isArray(value) ? value.filter((message) => typeof message === 'string' && message !== '') : []
}

/**
 * Wrap a HostAdapter so listTools carries static owner attribution (Task 7
 * wiring). The six HostAdapter methods keep their semantics: only listTools is
 * replaced (its rows come from attributeTools) and the diagnostic additions
 * merge the host's warnings snapshot with the attribution warnings.
 *
 * @param {object} host createHostAdapter-shaped adapter
 * @param {{ profilePath?: string }} [options] explicit profile override; it
 *   wins over host.profilePath()
 * @returns {object} hostLike with the same six methods + warnings/takeWarnings
 */
export function withAttribution(host, options = {}) {
  const base = isRecord(host) ? host : {}
  /** @type {string[]} */
  const ownWarnings = []
  /** @param {string} message */
  const warn = (message) => {
    const text = String(message)
    if (text === '' || ownWarnings.includes(text)) return
    ownWarnings.push(text)
  }
  /** @returns {string[]} */
  const hostWarnings = () => {
    try {
      return warningSnapshot(base.warnings)
    } catch {
      return []
    }
  }

  /** @returns {Promise<unknown[]>} */
  const readTools = async () => {
    if (typeof base.listTools !== 'function') {
      warn('host.listTools 不可用：无法读取工具清单')
      return []
    }
    try {
      const value = await base.listTools()
      if (!Array.isArray(value)) {
        warn('host.listTools 返回结构异常（应为数组）：按空清单处理')
        return []
      }
      return value
    } catch (error) {
      warn('host.listTools 失败：' + describeError(error))
      return []
    }
  }

  /** @returns {Promise<unknown[]>} */
  const readPlugins = async () => {
    if (typeof base.listPlugins !== 'function') {
      warn('host.listPlugins 不可用：无法读取插件清单')
      return []
    }
    try {
      const value = await base.listPlugins()
      if (!Array.isArray(value)) {
        warn('host.listPlugins 返回结构异常（应为数组）：按空清单处理')
        return []
      }
      return value
    } catch (error) {
      warn('host.listPlugins 失败：' + describeError(error))
      return []
    }
  }

  /** @returns {string} */
  const resolvedProfilePath = () => {
    if (typeof options?.profilePath === 'string' && options.profilePath !== '') return options.profilePath
    if (typeof base.profilePath !== 'function') return ''
    try {
      const value = base.profilePath()
      return typeof value === 'string' ? value : ''
    } catch (error) {
      warn('host.profilePath 读取失败：' + describeError(error))
      return ''
    }
  }

  /** @returns {(...args: unknown[]) => unknown} undefined-safe delegation */
  const delegate = (method) => (...args) =>
    typeof base[method] === 'function' ? base[method](...args) : undefined

  /** @returns {Promise<AttributionRow[]>} */
  const listTools = async () => {
    const [tools, plugins] = await Promise.all([readTools(), readPlugins()])
    const result = await attributeTools({ tools, plugins, profilePath: resolvedProfilePath() })
    for (const message of result.warnings) warn(message)
    return result.rows
  }

  return {
    get warnings() {
      return finalizeWarnings([...hostWarnings(), ...ownWarnings])
    },
    takeWarnings() {
      const own = ownWarnings.splice(0)
      let hostBatch = []
      if (typeof base.takeWarnings === 'function') {
        try {
          const batch = base.takeWarnings()
          if (Array.isArray(batch)) hostBatch = warningSnapshot(batch)
          else own.push('host.takeWarnings 返回结构异常（应为数组）')
        } catch (error) {
          own.push('host.takeWarnings 失败：' + describeError(error))
        }
      }
      return finalizeWarnings([...hostBatch, ...own])
    },
    listTools,
    listPlugins: delegate('listPlugins'),
    listSkills: delegate('listSkills'),
    sessionEvents: delegate('sessionEvents'),
    dispatchSupport: delegate('dispatchSupport'),
    createDispatchSession: delegate('createDispatchSession'),
    promptDispatchSession: delegate('promptDispatchSession'),
    readDispatchEvents: delegate('readDispatchEvents'),
    profilePath: delegate('profilePath'),
    dshVersion: delegate('dshVersion'),
  }
}
