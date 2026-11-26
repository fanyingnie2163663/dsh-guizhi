import test from 'node:test'
import assert from 'node:assert/strict'
import { schemas } from '../lib/schemas.js'
import { createMap, validateMap } from '../lib/map.js'

/** 一个 D7 capability；可用 overrides 覆盖单个字段。 */
function capability(overrides = {}) {
  return { id: 'read-code', title: '读代码', status: 'have', evidence: { source: 'scan' }, ...overrides }
}

/** 一个 D7 stage。 */
function stage(overrides = {}) {
  return { id: 'understand', title: '理解需求', capabilities: [capability()], ...overrides }
}

/** 一张合法地图：两个阶段，覆盖 have/missing/redundant 三种状态。 */
function validInput() {
  return {
    scenarios: ['dev', 'research'],
    custom: '给客户做技术方案',
    stages: [
      {
        id: 'understand',
        title: '理解需求',
        capabilities: [
          capability(),
          capability({ id: 'search-web', title: '查资料', status: 'missing', evidence: { source: 'catalog' } }),
          capability({ id: 'legacy-tool', title: '旧工具', status: 'redundant', evidence: {} }),
        ],
      },
      stage({ id: 'deliver', title: '交付', capabilities: [] }),
    ],
  }
}

/** 断言校验失败并返回可读 errors。 */
function failing(result) {
  assert.equal(result.ok, false, '应判为失败：' + JSON.stringify(result.errors))
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, '失败必须带 errors')
  return result.errors
}

test('createMap：合法输入原样组装出 {scenarios, custom, stages} 并通过 D7 校验', () => {
  const input = validInput()
  const map = createMap(input)
  assert.deepEqual(map, input)
  assert.deepEqual(validateMap(map), { ok: true, errors: [] })
  assert.deepEqual(schemas.map.validate(map), { ok: true, errors: [] })
})

test('createMap：custom 可省略，省略时不补空字符串', () => {
  const map = createMap({ scenarios: ['dev'], stages: [] })
  assert.deepEqual(map, { scenarios: ['dev'], stages: [] })
  assert.equal(Object.hasOwn(map, 'custom'), false)
  assert.deepEqual(validateMap(map), { ok: true, errors: [] })
})

test('createMap / validateMap：空阶段地图结构合法（种子先只有场景，能力点由后续任务补）', () => {
  assert.deepEqual(validateMap({ scenarios: [], stages: [] }), { ok: true, errors: [] })
  assert.deepEqual(validateMap(createMap({ scenarios: ['dev'], stages: [] })), { ok: true, errors: [] })
})

test('validateMap：直接复用 schemas.map.validate（同一函数，不另写形状判断）', () => {
  assert.equal(validateMap, schemas.map.validate)
  for (const value of [null, undefined, 'map', 42, []]) {
    const result = validateMap(value)
    assert.equal(result.ok, false, '非对象输入应判失败而不是抛错')
    assert.ok(result.errors.length > 0)
  }
})

test('缺 evidence 的 capability 被拒：validateMap 指字段，createMap 抛 MapValidationError', () => {
  const input = validInput()
  delete input.stages[0].capabilities[0].evidence
  const errors = failing(validateMap(input))
  assert.ok(errors.some((message) => message.includes('evidence')), JSON.stringify(errors))
  assert.throws(
    () => createMap(input),
    (error) => {
      assert.equal(error.name, 'MapValidationError')
      assert.ok(error.message.includes('地图校验失败'))
      assert.ok(error.message.includes('evidence'))
      assert.deepEqual(error.errors, errors)
      return true
    },
  )
})

test('capability status 非 have|missing|redundant 被拒（createMap 同样生效）', () => {
  for (const status of ['unused', 'HAVE', '', null]) {
    const input = validInput()
    input.stages[0].capabilities[0].status = status
    const errors = failing(validateMap(input))
    assert.ok(errors.some((message) => message.includes('status')), JSON.stringify(errors))
    assert.ok(
      errors.some((message) => message.includes('have|missing|redundant')),
      'errors 应给出允许值：' + JSON.stringify(errors),
    )
    assert.throws(() => createMap(input), /status/, String(status))
  }
})

test('重复 stage id 被拒（createMap 同样生效）', () => {
  const input = validInput()
  input.stages[1].id = input.stages[0].id
  const errors = failing(validateMap(input))
  assert.ok(
    errors.some((message) => message.includes('重复') && message.includes('understand')),
    JSON.stringify(errors),
  )
  assert.throws(() => createMap(input), /重复/)
})

test('createMap：必填字段缺失或类型不对时抛错，不静默补默认值', () => {
  const cases = [
    undefined,
    null,
    'map',
    {},
    { scenarios: ['dev'] },
    { stages: [] },
    { scenarios: 'dev', stages: [] },
    { scenarios: [], stages: 'x' },
  ]
  for (const input of cases) {
    const label = JSON.stringify(input) ?? String(input)
    assert.throws(() => createMap(input), /地图校验失败/, label)
  }
})

test('createMap：封闭形状（D9）——stage 未知字段被拒', () => {
  const input = validInput()
  input.stages[0].order = 1
  assert.throws(() => createMap(input), /未知字段/)
})

test('createMap：custom 显式传非字符串被拒，不静默丢弃', () => {
  const input = validInput()
  input.custom = 42
  const errors = failing(validateMap(input))
  assert.ok(errors.some((message) => message.includes('custom')), JSON.stringify(errors))
  assert.throws(() => createMap(input), /custom/)
})

test('createMap：不改写入参，返回新的顶层对象', () => {
  const input = validInput()
  const before = JSON.stringify(input)
  const map = createMap(input)
  assert.equal(JSON.stringify(input), before)
  assert.notStrictEqual(map, input)
})
