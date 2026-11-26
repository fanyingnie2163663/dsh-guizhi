/**
 * Shared output contract for every stow_* tool (defineTool requires it).
 *
 * Extracted from lib/index.js in fix wave F6 so the shape is assertable in a
 * static test (test/tool-output.test.js) without importing
 * @deepseek-ai/dsh-tools: this module is a plain object literal (D11).
 *
 * @module @fanyingnie/dsh-guizhi/tool-output
 */

/** Every stow_* tool returns one JSON string in a single text part. */
export const TOOL_OUTPUT = Object.freeze({
  schema: Object.freeze({
    type: 'object',
    additionalProperties: true,
    properties: Object.freeze({ text: Object.freeze({ type: 'string', required: true }) }),
  }),
  /**
   * Render the tool value as the host's text content block.
   * @param {unknown} _args
   * @param {{ text: string }} value
   * @returns {Array<{ type: 'text', text: string }>}
   */
  render: (_args, value) => [{ type: 'text', text: value.text }],
})
