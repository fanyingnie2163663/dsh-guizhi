import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISPATCH_KIND_MAP,
  DISPATCH_KIND_PACK,
  allowedToolsForPack,
  buildMapPrompt,
  buildPackWorkerPrompt,
  createDispatchRecord,
  deriveDispatchState,
  describeDispatch,
  isSessionMissingError,
} from '../lib/dispatch.js'

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
  assert.match(text, /suggestion/)
  assert.match(text, /精简建议/)
  assert.match(text, /redundant/)
})

test('deriveDispatchState: 标记前无 user/message 视为 running', () => {
  const read = { status: 'events', events: [{ seq: 1, time: 1500, type: 'turn/end', data: {} }] }
  assert.equal(deriveDispatchState(record, read, 2000).state, 'running')
})

test('deriveDispatchState: 标记后的 turn/end 判 done', () => {
  const read = {
    status: 'events',
    events: [
      { seq: 1, time: 1500, type: 'user/message', data: { source: { rpcId: 'r1' } } },
      { seq: 2, time: 1600, type: 'turn/start', data: {} },
      { seq: 3, time: 2000, type: 'turn/end', data: {} },
    ],
  }
  const derived = deriveDispatchState(record, read, 2500)
  assert.equal(derived.state, 'done')
  assert.equal(derived.finishedAt, new Date(2000).toISOString())
})

test('deriveDispatchState: 超时 / 失败 / 会话缺失 / 读取失败三态', () => {
  assert.equal(deriveDispatchState(record, { status: 'events', events: [] }, 1000 + 15 * 60 * 1000 + 1).state, 'timeout')
  assert.equal(deriveDispatchState({ ...record, state: 'failed', error: 'boom' }, null, 2000).state, 'failed')
  assert.equal(deriveDispatchState(record, { status: 'missing' }, 2000).state, 'lost')
  const unreadable = deriveDispatchState(record, { status: 'unreadable', error: 'io' }, 2000)
  assert.equal(unreadable.state, 'unknown')
  assert.match(unreadable.error, /io/)
  assert.equal(deriveDispatchState(record, null, 2000).state, 'unknown')
})

test('isSessionMissingError 只把明确的 not-found 判成会话缺失', () => {
  assert.equal(isSessionMissingError({ code: 'session/not-found' }), true)
  assert.equal(isSessionMissingError(new Error('session "x" not found')), true)
  assert.equal(isSessionMissingError(new Error('agent busy')), false)
  assert.equal(isSessionMissingError(null), false)
})

test('describeDispatch 不泄漏 requestId，保留可展示字段', () => {
  const out = describeDispatch(record, { state: 'running' })
  assert.equal(out.state, 'running')
  assert.equal(out.sessionId, 's1')
  assert.equal('requestId' in out, false)
})

/* ------------------------------------------------- S3：pack 受限 worker */

/** A stored pack with two stages, duplicate tool names and one skill. */
const PACK = {
  version: 1,
  id: 'pack-abcd1234',
  title: '研发包',
  stageIds: ['understand', 'deliver'],
  rows: [
    { stageId: 'understand', stageTitle: '理解需求', capabilityId: 'read-code', capabilityTitle: '读代码', status: 'have', tools: ['read'], skills: ['brainstorming'] },
    { stageId: 'deliver', stageTitle: '交付', capabilityId: 'ship', capabilityTitle: '交付结果', status: 'missing', tools: [], skills: [] },
  ],
  tools: ['read', 'write', 'read'],
  skills: ['brainstorming'],
  items: [],
  requirements: { appliesAt: 'manual', ownSession: false },
}

test('DISPATCH_KIND_* 常量：map 保持原值，新增 pack', () => {
  assert.equal(DISPATCH_KIND_MAP, 'map')
  assert.equal(DISPATCH_KIND_PACK, 'pack')
})

test('allowedToolsForPack：去重、排除空串/非字符串，不自动加入 run_code', () => {
  assert.deepEqual(allowedToolsForPack(PACK), ['read', 'write'])
  assert.equal(allowedToolsForPack(PACK).includes('run_code'), false, '不得自动加入 run_code')
  assert.deepEqual(allowedToolsForPack({ tools: ['read', 'read', '', '  ', 42, null, { name: 'x' }] }), ['read'])
  assert.deepEqual(allowedToolsForPack({ tools: [] }), [])
  assert.deepEqual(allowedToolsForPack(null), [])
  assert.deepEqual(allowedToolsForPack({}), [])
})

test('buildPackWorkerPrompt：受限 worker、只使用清单工具、软约束与验收清单', () => {
  const text = buildPackWorkerPrompt(PACK)
  for (const phrase of [
    '归置',
    '受限 worker',
    '研发包',
    'pack-abcd1234',
    '理解需求',
    'read-code',
    '读代码',
    '交付结果',
    '只使用以下工具',
    'read',
    'write',
    '清单外工具仍可见',
    '不要使用',
    'run_code',
    '验收清单',
    '软约束',
  ]) {
    assert.ok(text.includes(phrase), 'prompt 缺少「' + phrase + '」：\n' + text)
  }
  // 不得包含本机路径或用量信息
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\/Users\/|\/home\/|used30d|近 ?30 天|本机路径/)
  assert.doesNotMatch(text, /这个活只需要/)
})

test('buildPackWorkerPrompt：空清单仍给出结构化 worker prompt 并写明没有工具', () => {
  const text = buildPackWorkerPrompt({ id: 'pack-empty', title: '空包', stageIds: [], rows: [], tools: [], skills: [] })
  assert.match(text, /空包/)
  assert.match(text, /本装配清单没有工具/)
  assert.match(text, /只使用以下工具/)
  assert.match(text, /软约束/)
  const unknown = buildPackWorkerPrompt(undefined)
  assert.match(unknown, /受限 worker/)
})
