import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_SCENARIOS, normalizeScenarios } from '../lib/scenarios.js'

/** 设计文档 §5 场景页钉死的 6 个 chips（顺序即渲染顺序）。 */
const PINNED = [
  ['content', '内容生产'],
  ['design', '视觉设计'],
  ['dev', '研发'],
  ['research', '调研'],
  ['office', '办公'],
  ['daily', '日常'],
]

const PINNED_IDS = PINNED.map(([id]) => id)

test('BUILTIN_SCENARIOS：固定 6 个，id/title 与设计文档 §5 一致', () => {
  assert.equal(BUILTIN_SCENARIOS.length, 6)
  assert.deepEqual(
    BUILTIN_SCENARIOS.map((scenario) => [scenario.id, scenario.title]),
    PINNED,
  )
})

test('BUILTIN_SCENARIOS 只读：常量数组与每个场景都被冻结', () => {
  assert.ok(Object.isFrozen(BUILTIN_SCENARIOS))
  for (const scenario of BUILTIN_SCENARIOS) assert.ok(Object.isFrozen(scenario), scenario.id)
})

test('normalizeScenarios：6 个内置 id 全部合法', () => {
  assert.deepEqual(normalizeScenarios({ selected: PINNED_IDS }).selected, PINNED_IDS)
})

test('normalizeScenarios：未知 id 被丢弃（非字符串元素同样丢弃）', () => {
  const { selected } = normalizeScenarios({
    selected: ['dev', 'no-such-scenario', 'research', 42, null, {}, ''],
  })
  assert.deepEqual(selected, ['dev', 'research'])
})

test('normalizeScenarios：重复 id 去重且保留首次出现的顺序', () => {
  assert.deepEqual(normalizeScenarios({ selected: ['dev', 'research', 'dev', 'dev'] }).selected, [
    'dev',
    'research',
  ])
})

test('normalizeScenarios：空选择返回空数组，custom 缺省为空串', () => {
  assert.deepEqual(normalizeScenarios({ selected: [] }), { selected: [], custom: '' })
  assert.deepEqual(normalizeScenarios({}), { selected: [], custom: '' })
  assert.deepEqual(normalizeScenarios(), { selected: [], custom: '' })
  assert.deepEqual(normalizeScenarios(null), { selected: [], custom: '' })
})

test('normalizeScenarios：坏输入降级为空选择/空 custom，不抛错', () => {
  const cases = [
    undefined,
    null,
    'dev',
    42,
    [],
    { selected: 'dev' },
    { selected: { dev: true }, custom: 7 },
    { custom: null },
  ]
  for (const input of cases) {
    const label = JSON.stringify(input) ?? String(input)
    assert.deepEqual(normalizeScenarios(input), { selected: [], custom: '' }, label)
  }
})

test('normalizeScenarios：custom 超过 200 字按字符数截断到 200', () => {
  const long = '字'.repeat(250)
  const { custom } = normalizeScenarios({ selected: ['dev'], custom: long })
  assert.equal(custom.length, 200)
  assert.equal(custom, '字'.repeat(200))
})

test('normalizeScenarios：custom 恰好 200 字不截断，201 字截断', () => {
  assert.equal(normalizeScenarios({ custom: 'a'.repeat(200) }).custom, 'a'.repeat(200))
  assert.equal(normalizeScenarios({ custom: 'a'.repeat(201) }).custom, 'a'.repeat(200))
})

test('normalizeScenarios：按字符（码点）截断，不劈开代理对', () => {
  const { custom } = normalizeScenarios({ custom: '😀'.repeat(250) })
  assert.equal(Array.from(custom).length, 200, '200 个字符')
  assert.equal(custom.length, 400, '200 个 emoji 是 400 个 UTF-16 单元')
  assert.equal(
    [...custom].every((char) => char === '😀'),
    true,
    '不允许出现孤立代理项',
  )
})

test('normalizeScenarios：不改写入参', () => {
  const input = { selected: ['dev', 'bogus', 'dev'], custom: 'x'.repeat(250) }
  const before = JSON.stringify(input)
  normalizeScenarios(input)
  assert.equal(JSON.stringify(input), before)
})
