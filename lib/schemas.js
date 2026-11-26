/**
 * Hand-written validators for the six JSON documents Guizhi persists and
 * exchanges (contract D7 + Task 7 selections + F2 packs storage). No
 * third-party schema library: the contract is small and the runtime dependency
 * budget is exactly one package (yaml).
 *
 * Rules (contract D9):
 * - Every declared object is closed: an undeclared key is an error.
 * - Failures never throw; they come back as { ok: false, errors: string[] }
 *   with a stable, readable field path such as
 *   "stages[0].capabilities[1].status: 必须是 have|missing|redundant 之一".
 * - The validators are total: null, primitives, arrays and garbage all produce
 *   a normal failure result.
 *
 * Two shapes stay open on purpose. map.stages[].capabilities[].evidence is
 * pinned by D7 as an object only (its keys are data-source specific), and
 * pack.rows / pack.items are host/declaration-owned objects whose inner shape
 * v1 does not define; both are checked as plain objects and their keys are left
 * untouched.
 *
 * @module @fanyingnie/dsh-guizhi/schemas
 */

/**
 * @typedef {object} ValidationResult
 * @property {boolean} ok
 * @property {string[]} errors Readable, stable messages; empty when ok.
 */

/**
 * A checker walks one value and appends "path: message" lines to errors.
 * The empty path means the value itself is the root of the document.
 * @typedef {(value: unknown, path: string, errors: string[]) => void} Checker
 */

/** Render a field path for messages; the document root has no key.
 * @param {string} path
 * @returns {string}
 */
function label(path) {
  return path === '' ? '(根)' : path
}

/** Join a parent path and a property name.
 * @param {string} base
 * @param {string} key
 * @returns {string}
 */
function childPath(base, key) {
  return base === '' ? key : base + '.' + key
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Mark a checker as optional for the enclosing object. A present-but-undefined
 * value counts as absent (JSON has no undefined, JS callers occasionally do).
 * @param {Checker} check
 * @returns {Checker & { optional: true }}
 */
function optional(check) {
  const wrapped = (value, path, errors) => check(value, path, errors)
  wrapped.optional = true
  return wrapped
}

/** @returns {Checker} any string (D7 declares a plain string, empty included) */
function string() {
  return (value, path, errors) => {
    if (typeof value !== 'string') errors.push(label(path) + ': 必须是字符串')
  }
}

/** @returns {Checker} a non-negative integer, the shape of every count/total */
function count() {
  return (value, path, errors) => {
    if (!Number.isInteger(value) || value < 0) {
      errors.push(label(path) + ': 必须是非负整数')
    }
  }
}

/** @param {readonly unknown[]} values @returns {Checker} one of an enumeration */
function oneOf(values) {
  const rendered = values.join('|')
  return (value, path, errors) => {
    if (!values.includes(value)) {
      errors.push(label(path) + ': 必须是 ' + rendered + ' 之一')
    }
  }
}

/** @param {unknown} expected @returns {Checker} exactly the pinned constant */
function literal(expected) {
  const rendered = JSON.stringify(expected)
  return (value, path, errors) => {
    if (value !== expected) {
      errors.push(label(path) + ': 必须等于 ' + rendered)
    }
  }
}

/** @param {Checker} check @returns {Checker} null passes, anything else is checked */
function nullable(check) {
  return (value, path, errors) => {
    if (value !== null) check(value, path, errors)
  }
}

/** @param {Checker} check @returns {Checker} an array whose every element passes */
function arrayOf(check) {
  return (value, path, errors) => {
    if (!Array.isArray(value)) {
      errors.push(label(path) + ': 必须是数组')
      return
    }
    value.forEach((item, index) => check(item, path + '[' + index + ']', errors))
  }
}

/** @returns {Checker} a plain object whose keys are deliberately not inspected */
function openObject() {
  return (value, path, errors) => {
    if (!isPlainObject(value)) errors.push(label(path) + ': 必须是对象')
  }
}

/**
 * @param {Record<string, Checker>} shape
 * @returns {Checker} a closed object: every declared key is checked, and every
 *   undeclared key is reported as an unknown field (D9).
 */
function objectOf(shape) {
  return (value, path, errors) => {
    if (!isPlainObject(value)) {
      errors.push(label(path) + ': 必须是对象')
      return
    }
    for (const [key, check] of Object.entries(shape)) {
      const at = childPath(path, key)
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        if (check.optional !== true) errors.push(at + ': 缺少必填字段')
        continue
      }
      check(value[key], at, errors)
    }
    for (const key of Object.keys(value).sort()) {
      if (!Object.hasOwn(shape, key)) errors.push(childPath(path, key) + ': 未知字段')
    }
  }
}

/**
 * @param {Checker} check
 * @returns {{ validate: (value: unknown) => ValidationResult }}
 */
function makeSchema(check) {
  return Object.freeze({
    /**
     * Validate one value against this document contract.
     * @param {unknown} value
     * @returns {ValidationResult}
     */
    validate(value) {
      const errors = []
      check(value, '', errors)
      return { ok: errors.length === 0, errors }
    },
  })
}

const pluginShape = objectOf({
  name: string(),
  version: optional(string()),
  source: string(),
})

const toolShape = objectOf({
  name: string(),
  description: string(),
  owners: arrayOf(string()),
  used30d: nullable(count()),
  lastUsedAt: nullable(string()),
})

const skillShape = objectOf({
  name: string(),
  source: optional(string()),
})

const scanCheck = objectOf({
  plugins: arrayOf(pluginShape),
  tools: arrayOf(toolShape),
  skills: arrayOf(skillShape),
  totals: objectOf({
    plugins: count(),
    tools: count(),
    skills: count(),
    unusedTools: count(),
  }),
  warnings: arrayOf(string()),
  generatedAt: string(),
})

const capabilityShape = objectOf({
  id: string(),
  title: string(),
  status: oneOf(['have', 'missing', 'redundant']),
  evidence: openObject(),
})

/**
 * One workflow stage. R-4A extends the closed D7 stage shape with two optional
 * name lists (tools/skills) so a pack can merge the stage's declared tool and
 * skill names; both are typed string arrays (never open objects), and any
 * other unknown stage key is still rejected by objectOf.
 */
const stageShape = objectOf({
  id: string(),
  title: string(),
  capabilities: arrayOf(capabilityShape),
  tools: optional(arrayOf(string())),
  skills: optional(arrayOf(string())),
})

const mapCheck = objectOf({
  scenarios: arrayOf(string()),
  custom: optional(string()),
  stages: arrayOf(stageShape),
})

/**
 * The map checker plus the cross-field rule the contract pins: stage ids are
 * unique. Duplicates are reported at the second and later occurrences.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 */
function mapWithUniqueStages(value, path, errors) {
  mapCheck(value, path, errors)
  if (!isPlainObject(value) || !Array.isArray(value.stages)) return
  const seen = new Set()
  value.stages.forEach((stage, index) => {
    if (!isPlainObject(stage) || typeof stage.id !== 'string') return
    if (seen.has(stage.id)) {
      errors.push('stages[' + index + '].id: 重复的阶段 id ' + JSON.stringify(stage.id))
    } else {
      seen.add(stage.id)
    }
  })
}

const packCheck = objectOf({
  version: literal(1),
  id: string(),
  title: string(),
  createdAt: string(),
  stageIds: arrayOf(string()),
  rows: arrayOf(openObject()),
  tools: arrayOf(string()),
  skills: arrayOf(string()),
  items: arrayOf(openObject()),
  requirements: objectOf({
    appliesAt: literal('new-session'),
    ownSession: literal(false),
  }),
})

/**
 * The stored packs document (F2/R-8A): every row is the full authoritative D7
 * pack, so this schema reuses packCheck instead of defining a second shape.
 */
const packsCheck = objectOf({
  packs: arrayOf(packCheck),
})

const proposalItemShape = objectOf({
  id: string(),
  kind: oneOf(['install', 'pack', 'skill']),
  title: string(),
  effect: string(),
  evidence: objectOf({
    source: string(),
    refs: optional(arrayOf(string())),
  }),
})

const proposalsCheck = objectOf({
  items: arrayOf(proposalItemShape),
  generatedAt: string(),
})

const mapSchema = makeSchema(mapWithUniqueStages)

/**
 * The saved scenario selection (Task 7): exactly the D7 scenario page state.
 * Closed object: selected is a string[] of built-in ids (normalization happens
 * at the route boundary) and custom is the one-sentence free text.
 */
const selectionsCheck = objectOf({
  selected: arrayOf(string()),
  custom: string(),
})

/**
 * The six state/document validators. Each is { validate(value) -> { ok, errors } }
 * and each rejects unknown fields.
 * @type {Readonly<{
 *   scan: { validate: (value: unknown) => ValidationResult },
 *   map: { validate: (value: unknown) => ValidationResult },
 *   pack: { validate: (value: unknown) => ValidationResult },
 *   proposals: { validate: (value: unknown) => ValidationResult },
 *   selections: { validate: (value: unknown) => ValidationResult },
 *   packs: { validate: (value: unknown) => ValidationResult },
 * }>}
 */
export const schemas = Object.freeze({
  scan: makeSchema(scanCheck),
  map: mapSchema,
  pack: makeSchema(packCheck),
  proposals: makeSchema(proposalsCheck),
  selections: makeSchema(selectionsCheck),
  packs: makeSchema(packsCheck),
})

/* Named aliases for callers that prefer a direct import (lib/map.js, lib/packs.js). */
export const validateScan = schemas.scan
export const validateMap = mapSchema
export const validatePack = schemas.pack
export const validateProposals = schemas.proposals
export const validateSelections = schemas.selections
