/**
 * Map: assemble and validate the D7 workflow map document.
 *
 * The map is `{ scenarios: string[], custom?: string, stages: [{ id, title,
 * capabilities: [{ id, title, status: 'have'|'missing'|'redundant',
 * evidence: object }] }] }` (contract D7). This module only provides the
 * deterministic structure: scenario ids come from lib/scenarios.js, stage
 * decomposition is the caller's job (AI or a seed template), and every
 * capability's `evidence` object is filled in later (Task 5/7). No model call,
 * no disk access — the module is pure.
 *
 * Shape validation is not reimplemented here: validateMap *is*
 * schemas.map.validate (including the cross-field unique-stage-id rule and the
 * D9 closed objects). createMap validates through the same function, so an
 * illegal map can never reach the store/routes unnoticed.
 *
 * @module @fanyingnie/dsh-guizhi/map
 */
import { schemas } from './schemas.js'

/**
 * Validate one map document against the D7 contract.
 *
 * This is the exact `schemas.map.validate` function reference — importing the
 * authoritative checker instead of copying its shape rules (D9). It returns
 * `{ ok, errors }`, is total (never throws) and rejects unknown fields.
 * @type {(value: unknown) => { ok: boolean, errors: string[] }}
 */
export const validateMap = schemas.map.validate

/**
 * Build the Error createMap throws for an illegal map. `.errors` carries the
 * schema's readable field paths so routes can answer 400 with details.
 * @param {string[]} errors
 * @returns {Error & { errors: string[] }}
 */
function mapValidationError(errors) {
  const error = new Error('地图校验失败：' + errors.join('；'))
  error.name = 'MapValidationError'
  error.errors = errors
  return error
}

/**
 * Assemble a D7 map from a scenario selection plus workflow stages.
 *
 * `scenarios` and `stages` are required; an absent field is a validation
 * failure (no silent defaults). `custom` is optional and echoed only when the
 * caller provides it, so a map without a custom scenario stays compact.
 * The result is validated with validateMap before it is returned: an illegal
 * map (capability without evidence, unknown status, duplicate stage id, unknown
 * field, ...) throws MapValidationError instead of producing a document the
 * store would later reject.
 *
 * @param {{ scenarios?: unknown, custom?: unknown, stages?: unknown }} [input]
 * @returns {{ scenarios: string[], custom?: string, stages: object[] }}
 * @throws {Error & { errors: string[] }} name is 'MapValidationError'
 */
export function createMap(input) {
  const source = typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {}
  /** @type {{ scenarios?: unknown, custom?: unknown, stages?: unknown }} */
  const map = { scenarios: source.scenarios, stages: source.stages }
  if (Object.hasOwn(source, 'custom') && source.custom !== undefined) map.custom = source.custom
  const result = validateMap(map)
  if (!result.ok) throw mapValidationError(result.errors)
  return /** @type {{ scenarios: string[], custom?: string, stages: object[] }} */ (map)
}
