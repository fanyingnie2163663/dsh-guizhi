import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { TOOL_OUTPUT } from '../lib/tool-output.js'

/**
 * F6: the stow_* tool output contract was extracted into lib/tool-output.js so it
 * can be asserted statically without importing @deepseek-ai/dsh-tools (D11).
 */

test('TOOL_OUTPUT.schema：object + text:string 必填 + additionalProperties 显式 true', () => {
  const schema = TOOL_OUTPUT.schema
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, true)
  assert.deepEqual(Object.keys(schema.properties), ['text'])
  assert.equal(schema.properties.text.type, 'string')
  assert.equal(schema.properties.text.required, true, '宿主 defineTool DSL 只接受 required: true')
})

test('TOOL_OUTPUT.render：返回单条 text content block，内容就是 value.text', () => {
  const rendered = TOOL_OUTPUT.render({}, { text: '{"ok":true}' })
  assert.deepEqual(rendered, [{ type: 'text', text: '{"ok":true}' }])
  assert.deepEqual(TOOL_OUTPUT.render(null, { text: '' }), [{ type: 'text', text: '' }])
})

test('D11：lib/ 下只有 lib/index.js 静态 import @deepseek-ai/dsh-tools', async () => {
  const modules = [
    'apply',
    'attribution',
    'catalog',
    'host',
    'http',
    'index',
    'map',
    'packs',
    'probe',
    'routes',
    'scan',
    'scenarios',
    'schemas',
    'store',
    'tool-output',
    'usage',
  ]
  const offenders = []
  // A real import edge only: comments elsewhere may mention the package name.
  const importPattern = /(?:from\s*|import\s*\(\s*)['"]@deepseek-ai\/dsh-tools['"]/
  for (const name of modules) {
    const source = await readFile(new URL('../lib/' + name + '.js', import.meta.url), 'utf8')
    if (importPattern.test(source)) offenders.push(name + '.js')
  }
  assert.deepEqual(offenders, ['index.js'], 'D11 被破坏：' + offenders.join(', '))
})
