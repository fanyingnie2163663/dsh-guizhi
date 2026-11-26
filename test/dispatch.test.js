import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMapPrompt, createDispatchRecord, deriveDispatchState, describeDispatch } from '../lib/dispatch.js'

const SCAN = { totals: { plugins: 31, tools: 66, skills: 32, unusedTools: 4 }, tools: [{ name: 'read' }], warnings: [] }
const SELECTIONS = { selected: ['dev', 'office'], custom: '' }
const record = createDispatchRecord({ kind: 'map', sessionId: 's1', requestId: 'r1', startedAt: 1000 })

test('buildMapPrompt 携带扫描摘要、场景与 tool 约定', () => {
  const text = buildMapPrompt({ scan: SCAN, selections: SELECTIONS })
  assert.match(text, /stow_map_save/)
  assert.match(text, /31/)
  assert.match(text, /66/)
  assert.match(text, /dev/)
  assert.match(text, /office/)
  assert.match(text, /只读/)
})

test('deriveDispatchState: 标记前无 user/message 视为 running', () => {
  const events = [{ seq: 1, time: 1500, type: 'turn/end', data: {} }]
  assert.equal(deriveDispatchState(record, events, 2000).state, 'running')
})

test('deriveDispatchState: 标记后的 turn/end 判 done', () => {
  const events = [
    { seq: 1, time: 1500, type: 'user/message', data: { source: { rpcId: 'r1' } } },
    { seq: 2, time: 1600, type: 'turn/start', data: {} },
    { seq: 3, time: 2000, type: 'turn/end', data: {} },
  ]
  const derived = deriveDispatchState(record, events, 2500)
  assert.equal(derived.state, 'done')
  assert.equal(derived.finishedAt, new Date(2000).toISOString())
})

test('deriveDispatchState: 超时、失败、会话丢失', () => {
  assert.equal(deriveDispatchState(record, [], 1000 + 15 * 60 * 1000 + 1).state, 'timeout')
  assert.equal(deriveDispatchState({ ...record, state: 'failed', error: 'boom' }, [], 2000).state, 'failed')
  assert.equal(deriveDispatchState(record, null, 2000).state, 'lost')
})

test('describeDispatch 不泄漏 requestId，保留可展示字段', () => {
  const out = describeDispatch(record, { state: 'running' })
  assert.equal(out.state, 'running')
  assert.equal(out.sessionId, 's1')
  assert.equal('requestId' in out, false)
})
