/**
 * Skillpack (S2): compile a capability pack (装配清单) into a DSH workflow
 * skill (SKILL.md), and provide the name/path helpers apply() uses.
 *
 * A DSH skill is a directory under <$DSH_HOME>/skills holding a SKILL.md with a
 * YAML frontmatter (name, description). This module is the pure compiler:
 * buildPackSkill(pack) validates the pack through the authoritative
 * lib/packs.js validatePack and returns { name, description, markdown } without
 * touching the disk, the clock or any host service. apply() is the only writer;
 * it installs the markdown atomically and records the rollback ledger.
 *
 * Output rules:
 * - name is 'stow-' + pack.id and must match the kebab-case skill-name rule;
 *   every path segment is validated before apply() builds a path from it.
 * - frontmatter carries name/description plus disable-model-invocation: true, so
 *   a freshly installed skill does not join the model's default skill directory
 *   until the user removes that line by hand.
 * - title/description are single-line and truncated by Unicode code point
 *   (title 120, description 300) with an ellipsis; an overlong hand-edited title
 *   is truncated instead of failing the whole skill install.
 * - description is one line of Chinese naming the pack title and its tool/skill
 *   counts. It never carries a local path, usage figure or timestamp.
 * - markdown is deterministic: the same pack (ignoring createdAt) always yields
 *   the same bytes, so re-apply/rollback are reproducible. buildPack never
 *   writes a path, usage number or timestamp into the body.
 * - a legacy pack without a rows field is compiled through its stageIds plus
 *   tools/skills (old snapshots remain readable); an empty pack still produces a
 *   valid skill that explicitly says it carries no tool/skill.
 *
 * @module @fanyingnie/dsh-guizhi/skillpack
 */
import { isPackEmpty, validatePack } from './packs.js'

/** File name every DSH skill directory must carry. */
export const SKILL_FILE = 'SKILL.md'

/** Kebab-case lower-case name rule shared by DSH skill names and path segments. */
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Every generated skill name starts with this prefix, keeping stow skills scoped. */
const SKILL_NAME_PREFIX = 'stow-'

/** Frontmatter line keeping a freshly installed skill out of the model's default skill directory. */
const DISABLE_MODEL_INVOCATION = 'disable-model-invocation: true'

/** Code-point cap of the title used in the markdown heading and description. */
const TITLE_MAX_CODE_POINTS = 120

/** Code-point cap of the one-line frontmatter description. */
const DESCRIPTION_MAX_CODE_POINTS = 300

/** Appended when a title/description exceeds its code-point cap. */
const ELLIPSIS = '…'

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
 * Build the Error buildPackSkill/skillNameForPack throw for an unusable pack.
 * The message is meant to be shown to the user as-is; .errors carries the
 * schema field paths when the pack itself was rejected.
 * @param {string} message
 * @param {string[]} [errors]
 * @returns {Error & { errors?: string[] }}
 */
function skillPackError(message, errors) {
  const error = new Error(message)
  error.name = 'SkillPackError'
  if (Array.isArray(errors)) error.errors = errors
  return error
}

/**
 * Whether a string is a legal kebab-case skill name (and therefore a safe path
 * segment). Anything that is not a lower-case kebab string is refused.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSkillPackName(name) {
  return typeof name === 'string' && KEBAB_NAME.test(name)
}

/**
 * Derive the skill name of one pack: 'stow-' + pack.id.
 *
 * pack.id stays an open string in the D7 schema, so the name rule is enforced
 * here instead of trusting it: a value that cannot be a path segment throws a
 * SkillPackError rather than being turned into a path by a caller.
 * @param {unknown} pack
 * @returns {string}
 * @throws {Error & { errors?: string[] }} name is 'SkillPackError'
 */
export function skillNameForPack(pack) {
  const id = isPlainObject(pack) ? pack.id : undefined
  if (typeof id !== 'string' || id === '') {
    throw skillPackError('装配清单缺少可用的 id，无法生成技能名')
  }
  const name = SKILL_NAME_PREFIX + id
  if (!isSkillPackName(name)) {
    throw skillPackError(
      '装配清单 id 无法作为合法的 kebab-case 技能名：' + JSON.stringify(id) + '（生成 ' + JSON.stringify(name) + '）',
    )
  }
  return name
}

/**
 * Normalize a legacy pack before validation: packs written before the rows
 * derivation have no rows field. Defaulting it to [] keeps those snapshots
 * readable while every other schema rule still applies.
 * @param {unknown} pack
 * @returns {unknown}
 */
function withLegacyRows(pack) {
  if (isPlainObject(pack) && pack.rows === undefined) return { ...pack, rows: [] }
  return pack
}

/** Collapse whitespace so one title can never break a heading or description line. */
function plainText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Single-line, code-point-aware truncation: overlong text loses its tail and
 * gains an ellipsis instead of failing the install. The result never exceeds
 * maxCodePoints code points (non-string input becomes ''); short input is
 * returned unchanged. Code points (not UTF-16 units) keep emoji/CJK intact.
 * @param {unknown} value
 * @param {number} maxCodePoints
 * @returns {string}
 */
export function truncateSkillText(value, maxCodePoints) {
  const text = plainText(value)
  const limit = Number.isInteger(maxCodePoints) && maxCodePoints > 0 ? maxCodePoints : 0
  const points = Array.from(text)
  if (points.length <= limit) return text
  if (limit === 0) return ''
  return points.slice(0, limit - 1).join('') + ELLIPSIS
}

/** The pack title as it appears in the heading/description: single line, ≤120 code points. */
function packTitle(pack) {
  return truncateSkillText(plainText(pack.title) || pack.id, TITLE_MAX_CODE_POINTS)
}

/** Read a string field from an open row object. */
function rowText(row, key) {
  if (!isPlainObject(row)) return ''
  const value = row[key]
  return typeof value === 'string' ? plainText(value) : ''
}

/**
 * Normalize a name list: keep non-empty strings, de-duplicate, preserve order.
 * @param {unknown} value
 * @returns {string[]}
 */
function uniqueNames(value) {
  if (!Array.isArray(value)) return []
  const names = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = plainText(item)
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/** Read pack.stageIds as a de-duplicated string list (schema guarantees strings). */
function stageIdsOf(pack) {
  return uniqueNames(pack.stageIds)
}

/** One line description: truncated title + counts, no path/usage/timestamp, ≤300 code points. */
function describePack(pack) {
  const title = packTitle(pack)
  const tools = uniqueNames(pack.tools).length
  const skills = uniqueNames(pack.skills).length
  return truncateSkillText(
    '归置装配清单「' + title + '」：' + tools + ' 个工具 / ' + skills + ' 个技能；' +
      '应用时安装为 DSH 工作流技能，v1 只给建议，不限制工具面。',
    DESCRIPTION_MAX_CODE_POINTS,
  )
}

/**
 * Group pack.rows by stage, preserving first-seen order. A row whose stage
 * fields are unusable is skipped; when nothing usable remains the caller falls
 * back to stageIds (legacy/no-detail packs).
 * @param {unknown[]} rows
 */
function groupRows(rows) {
  const groups = []
  const byKey = new Map()
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    const stageId = rowText(row, 'stageId')
    const stageTitle = rowText(row, 'stageTitle')
    const key = stageId || stageTitle
    if (key === '') continue
    let group = byKey.get(key)
    if (group === undefined) {
      group = { key, title: stageTitle || stageId, rows: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
}

/** Render the rollback-friendly, deterministic SKILL.md body. */
function renderMarkdown(pack, name, description) {
  const title = packTitle(pack)
  const tools = uniqueNames(pack.tools)
  const skills = uniqueNames(pack.skills)
  const stageIds = stageIdsOf(pack)
  const groups = groupRows(Array.isArray(pack.rows) ? pack.rows : [])
  const empty = tools.length === 0 && skills.length === 0
  const lines = []

  lines.push('---')
  lines.push('name: ' + JSON.stringify(name))
  lines.push('description: ' + JSON.stringify(description))
  // Safe default: the skill is installed for a human to opt into, not silently
  // injected into every model turn (the user may edit this line by hand).
  lines.push(DISABLE_MODEL_INVOCATION)
  lines.push('---', '')
  lines.push('# ' + title, '')
  lines.push('## 适用说明', '')
  lines.push(
    '本技能由归置（Stow）根据装配清单生成，列出选中的工作流阶段、能力点与建议使用的工具/技能。' +
      'v1 只给建议，不限制工具面：安装本技能不会安装插件、不改动 profile，只提供执行顺序与验收清单。',
  )
  lines.push('')
  if (empty) lines.push('本装配清单没有工具/技能。', '')
  lines.push('## 阶段与能力点', '')
  if (groups.length === 0) {
    lines.push('装配清单没有逐能力点明细，只记录选中的阶段与建议清单。', '')
    lines.push('- 阶段：' + (stageIds.length > 0 ? stageIds.join('、') : '（无）'), '')
  } else {
    for (const group of groups) {
      lines.push('### ' + group.title, '')
      for (const row of group.rows) {
        const capability = rowText(row, 'capabilityTitle') || rowText(row, 'capabilityId') || '未命名能力点'
        const status = rowText(row, 'status') || 'unknown'
        const rowTools = uniqueNames(row.tools)
        const rowSkills = uniqueNames(row.skills)
        lines.push(
          '- ' + capability + '（' + status + '）：工具 ' +
            (rowTools.length > 0 ? rowTools.join('、') : '无') + '；技能 ' +
            (rowSkills.length > 0 ? rowSkills.join('、') : '无'),
        )
      }
      lines.push('')
    }
  }
  lines.push('## 建议工具', '')
  if (tools.length === 0) lines.push('- （本装配清单没有工具）')
  else for (const tool of tools) lines.push('- ' + tool)
  lines.push('', '## 建议技能', '')
  if (skills.length === 0) lines.push('- （本装配清单没有技能）')
  else for (const skill of skills) lines.push('- ' + skill)
  lines.push('', '## 执行步骤', '')
  lines.push('1. 读取「阶段与能力点」，按顺序逐阶段执行；状态为 missing 的能力点先补齐再继续。')
  lines.push('2. 优先使用「建议工具」里的工具完成对应能力点。')
  lines.push('3. 需要方法论时加载「建议技能」里的技能。')
  lines.push('4. 完成后逐项勾选「验收清单」。')
  lines.push('', '## 验收清单', '')
  if (groups.length > 0) {
    for (const group of groups) lines.push('- [ ] 阶段「' + group.title + '」的能力点已全部处理')
  } else {
    for (const id of stageIds) lines.push('- [ ] 阶段 ' + id + ' 已处理')
  }
  lines.push('- [ ] 建议工具已按需使用' + (tools.length > 0 ? '：' + tools.join('、') : '（本清单没有工具）'))
  lines.push('- [ ] 建议技能已按需加载' + (skills.length > 0 ? '：' + skills.join('、') : '（本清单没有技能）'))
  lines.push('')
  return lines.join('\n')
}

/**
 * Compile one pack into a DSH workflow skill (pure, deterministic).
 *
 * The pack is validated through the authoritative validatePack first (a legacy
 * pack without rows is normalized to rows: []). The returned markdown is a
 * ready-to-install SKILL.md: YAML frontmatter (name/description JSON-quoted
 * plus disable-model-invocation: true),
 * title, applicability note, row-grouped stages/capabilities (stageIds fallback
 * for a legacy pack), suggested tools and skills, execution steps and an
 * acceptance checklist. It never contains a local path, usage figure or
 * timestamp, so the same pack always compiles to the same bytes.
 *
 * @param {unknown} pack
 * @returns {{ name: string, description: string, markdown: string }}
 * @throws {Error & { errors?: string[] }} name is 'SkillPackError'
 */
export function buildPackSkill(pack) {
  const candidate = withLegacyRows(pack)
  const check = validatePack(candidate)
  if (!check.ok) {
    throw skillPackError('无法把装配清单编译成工作流技能：' + check.errors.join('；'), check.errors)
  }
  const name = skillNameForPack(candidate)
  const description = describePack(candidate)
  return { name, description, markdown: renderMarkdown(candidate, name, description) }
}

/* Re-exported so callers can check "empty pack" without a second import path;
 * kept as the exact lib/packs.js helper reference (no copied rule). */
export { isPackEmpty }
