import test from 'node:test'
import assert from 'node:assert/strict'
import { schemas } from '../lib/schemas.js'

/** A stable ISO timestamp for fixtures. */
const ISO = '2026-11-26T08:00:00.000Z'

/** @returns {object} a scan that satisfies the D7 shape. */
function validScan() {
  return {
    plugins: [
      { name: 'dsh-ops', version: '0.5.6', source: 'npm' },
      { name: 'dsh-better-sidebar', source: 'patch' },
    ],
    tools: [
      { name: 'read', description: 'Read a UTF-8 text file', owners: ['@deepseek-ai/dsh-tool-fs'], used30d: 12, lastUsedAt: ISO },
      { name: 'write', description: 'Write a UTF-8 text file', owners: [], used30d: null, lastUsedAt: null },
    ],
    skills: [{ name: 'brainstorming', source: 'user' }, { name: 'writing-plans' }],
    totals: { plugins: 2, tools: 2, skills: 2, unusedTools: 0 },
    warnings: [],
    generatedAt: ISO,
  }
}

/** @returns {object} a map that satisfies the D7 shape. */
function validMap() {
  return {
    scenarios: ['dev', 'research'],
    custom: '给客户做技术方案',
    stages: [
      {
        id: 'understand',
        title: '理解需求',
        capabilities: [
          { id: 'read-code', title: '读代码', status: 'have', evidence: { source: 'scan', tools: ['read'] } },
          { id: 'search-web', title: '查资料', status: 'missing', evidence: { source: 'catalog' } },
          { id: 'legacy-tool', title: '旧工具', status: 'redundant', evidence: {} },
        ],
      },
      { id: 'deliver', title: '交付', capabilities: [] },
    ],
  }
}

/** @returns {object} a pack that satisfies the D7 shape. */
function validPack() {
  return {
    version: 1,
    id: 'pack-dev-20261126',
    title: '研发包',
    createdAt: ISO,
    stageIds: ['understand', 'deliver'],
    rows: [],
    tools: ['read', 'write'],
    skills: ['brainstorming'],
    items: [],
    requirements: { appliesAt: 'new-session', ownSession: false },
  }
}

/** @returns {object} a proposals document that satisfies the D7 shape. */
function validProposals() {
  return {
    items: [
      {
        id: 'install-websearch',
        kind: 'install',
        title: '安装联网插件',
        effect: '新增 web_search / web_fetch',
        evidence: { source: 'catalog', refs: ['dsh-web@0.2.0'] },
      },
      { id: 'pack-dev', kind: 'pack', title: '研发包', effect: '合并两个阶段', evidence: { source: 'map' } },
      { id: 'skill-tdd', kind: 'skill', title: 'TDD 技能', effect: '派单草稿带上技能', evidence: { source: 'scan' } },
    ],
    generatedAt: ISO,
  }
}

/** Assert a validation result is a failure and return its errors. */
function failing(result) {
  assert.equal(result.ok, false, '应判为失败：' + JSON.stringify(result.errors))
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, '失败必须带可读 errors')
  for (const message of result.errors) assert.equal(typeof message, 'string', 'errors 每项都是字符串')
  return result.errors
}

test('schemas 导出 scan/map/pack/proposals 四个 { validate } 校验器', () => {
  for (const name of ['scan', 'map', 'pack', 'proposals']) {
    assert.equal(typeof schemas[name]?.validate, 'function', name + '.validate 必须是函数')
  }
})

test('四个校验器对非对象输入返回失败而不是抛错', () => {
  for (const name of ['scan', 'map', 'pack', 'proposals']) {
    for (const value of [null, undefined, 'text', 42, [], true]) {
      const result = schemas[name].validate(value)
      assert.equal(result.ok, false, name + ' 应拒绝 ' + JSON.stringify(value))
      assert.ok(result.errors.length > 0, name + ' 的失败必须带 errors')
    }
  }
})

test('scan：合法扫描结果通过，errors 为空数组', () => {
  const scan = validScan()
  assert.deepEqual(schemas.scan.validate(scan), { ok: true, errors: [] })
})

test('scan：校验不修改输入对象', () => {
  const scan = validScan()
  const before = JSON.stringify(scan)
  schemas.scan.validate(scan)
  assert.equal(JSON.stringify(scan), before)
})

test('scan：缺字段、类型错误都判错且 errors 带字段路径', () => {
  const missing = validScan()
  delete missing.totals
  assert.ok(failing(schemas.scan.validate(missing)).some((message) => message.includes('totals')))

  const badType = validScan()
  badType.tools[0].used30d = '12'
  const badTypeErrors = failing(schemas.scan.validate(badType))
  assert.ok(badTypeErrors.some((message) => message.includes('tools[0].used30d')), JSON.stringify(badTypeErrors))

  const badLastUsed = validScan()
  badLastUsed.tools[1].lastUsedAt = 123
  assert.ok(failing(schemas.scan.validate(badLastUsed)).some((message) => message.includes('lastUsedAt')))

  const badTotals = validScan()
  badTotals.totals.unusedTools = -1
  assert.ok(failing(schemas.scan.validate(badTotals)).some((message) => message.includes('unusedTools')))
})

test('scan：未知字段（顶层/plugin/tool）一律判错', () => {
  const top = validScan()
  top.generatedBy = 'someone'
  assert.ok(failing(schemas.scan.validate(top)).some((message) => message.includes('未知字段') && message.includes('generatedBy')))

  const plugin = validScan()
  plugin.plugins[0].enabled = true
  assert.ok(failing(schemas.scan.validate(plugin)).some((message) => message.includes('未知字段')))

  const tool = validScan()
  tool.tools[0].cost = 3
  assert.ok(failing(schemas.scan.validate(tool)).some((message) => message.includes('未知字段')))
})

test('scan：用量未知是 null，不是 0；可选字段缺失合法', () => {
  const scan = validScan()
  scan.plugins = [{ name: 'dsh-better-sidebar', source: 'patch' }]
  scan.skills = [{ name: 'writing-plans' }]
  scan.tools = [{ name: 'read', description: 'Read', owners: [], used30d: null, lastUsedAt: null }]
  scan.totals = { plugins: 1, tools: 1, skills: 1, unusedTools: 0 }
  assert.deepEqual(schemas.scan.validate(scan), { ok: true, errors: [] })
})

test('map：合法地图通过，custom 可省略', () => {
  assert.deepEqual(schemas.map.validate(validMap()), { ok: true, errors: [] })
  const withoutCustom = validMap()
  delete withoutCustom.custom
  assert.deepEqual(schemas.map.validate(withoutCustom), { ok: true, errors: [] })
})

test('map：空对象判错，errors 含 stages（任务书 Step 1）', () => {
  const errors = failing(schemas.map.validate({}))
  assert.ok(errors.some((message) => message.includes('stages')), JSON.stringify(errors))
})

test('map：capability status 只接受 have|missing|redundant', () => {
  for (const status of ['have', 'missing', 'redundant']) {
    const map = validMap()
    map.stages[0].capabilities[0].status = status
    assert.deepEqual(schemas.map.validate(map), { ok: true, errors: [] }, status)
  }
  for (const status of ['unused', 'HAVE', '', null]) {
    const map = validMap()
    map.stages[0].capabilities[0].status = status
    const errors = failing(schemas.map.validate(map))
    assert.ok(errors.some((message) => message.includes('status')), JSON.stringify(errors))
    assert.ok(errors.some((message) => message.includes('have|missing|redundant')), 'errors 应说明允许值：' + JSON.stringify(errors))
  }
})

test('map：capability 必须带 evidence 对象，缺 evidence 被拒', () => {
  const missing = validMap()
  delete missing.stages[0].capabilities[0].evidence
  assert.ok(failing(schemas.map.validate(missing)).some((message) => message.includes('evidence')))

  const notObject = validMap()
  notObject.stages[0].capabilities[0].evidence = 'scan'
  assert.ok(failing(schemas.map.validate(notObject)).some((message) => message.includes('evidence')))
})

test('map：未知字段一律判错（顶层/stage/capability）', () => {
  const top = validMap()
  top.summary = 'x'
  assert.ok(failing(schemas.map.validate(top)).some((message) => message.includes('未知字段') && message.includes('summary')))

  const stage = validMap()
  stage.stages[0].order = 1
  assert.ok(failing(schemas.map.validate(stage)).some((message) => message.includes('未知字段')))

  const capability = validMap()
  capability.stages[0].capabilities[0].cost = 1
  assert.ok(failing(schemas.map.validate(capability)).some((message) => message.includes('未知字段')))
})

test('map：重复 stage id 被判错', () => {
  const map = validMap()
  map.stages[1].id = map.stages[0].id
  const errors = failing(schemas.map.validate(map))
  assert.ok(errors.some((message) => message.includes('重复') && message.includes('understand')), JSON.stringify(errors))
})

test('map：stage 支持可选 tools/skills（R-4A 扩展），缺省仍合法', () => {
  const withBoth = validMap()
  withBoth.stages[0].tools = ['read', 'grep']
  withBoth.stages[0].skills = ['brainstorming']
  assert.deepEqual(schemas.map.validate(withBoth), { ok: true, errors: [] })

  const withEmpty = validMap()
  withEmpty.stages[0].tools = []
  withEmpty.stages[1].skills = []
  assert.deepEqual(schemas.map.validate(withEmpty), { ok: true, errors: [] })

  // 两个字段都可缺省（既有 D7 map 一字不改仍然合法）
  assert.deepEqual(schemas.map.validate(validMap()), { ok: true, errors: [] })
})

test('map：stage 的 tools/skills 元素必须是 string，非数组/非法元素被拒', () => {
  const badElement = validMap()
  badElement.stages[0].tools = ['read', 7]
  const elementErrors = failing(schemas.map.validate(badElement))
  assert.ok(elementErrors.some((message) => message.includes('tools[1]')), JSON.stringify(elementErrors))

  const badSkills = validMap()
  badSkills.stages[1].skills = [null]
  assert.ok(failing(schemas.map.validate(badSkills)).some((message) => message.includes('skills[0]')))

  const notArray = validMap()
  notArray.stages[0].tools = 'read'
  assert.ok(failing(schemas.map.validate(notArray)).some((message) => message.includes('tools')))

  // 仍是封闭对象：新增两个键之外，未知 stage 字段继续被拒
  const stillClosed = validMap()
  stillClosed.stages[0].order = 1
  assert.ok(
    failing(schemas.map.validate(stillClosed)).some(
      (message) => message.includes('未知字段') && message.includes('order'),
    ),
  )
})

test('pack：合法能力包通过；version 必须为 1；requirements 固定值', () => {
  assert.deepEqual(schemas.pack.validate(validPack()), { ok: true, errors: [] })

  const badVersion = validPack()
  badVersion.version = 2
  assert.ok(failing(schemas.pack.validate(badVersion)).some((message) => message.includes('version')))

  const badApplies = validPack()
  badApplies.requirements.appliesAt = 'immediately'
  assert.ok(failing(schemas.pack.validate(badApplies)).some((message) => message.includes('appliesAt')))

  const badOwnSession = validPack()
  badOwnSession.requirements.ownSession = true
  assert.ok(failing(schemas.pack.validate(badOwnSession)).some((message) => message.includes('ownSession')))

  const missingRequirements = validPack()
  delete missingRequirements.requirements
  assert.ok(failing(schemas.pack.validate(missingRequirements)).some((message) => message.includes('requirements')))
})

test('pack：未知字段判错；stageIds 必须是字符串数组', () => {
  const unknown = validPack()
  unknown.extra = 1
  assert.ok(failing(schemas.pack.validate(unknown)).some((message) => message.includes('未知字段') && message.includes('extra')))

  const badStageIds = validPack()
  badStageIds.stageIds = ['understand', 7]
  assert.ok(failing(schemas.pack.validate(badStageIds)).some((message) => message.includes('stageIds[1]')))
})

test('proposals：合法提案通过；kind 枚举与 evidence.source 必填', () => {
  assert.deepEqual(schemas.proposals.validate(validProposals()), { ok: true, errors: [] })

  const badKind = validProposals()
  badKind.items[0].kind = 'upgrade'
  const kindErrors = failing(schemas.proposals.validate(badKind))
  assert.ok(kindErrors.some((message) => message.includes('kind')), JSON.stringify(kindErrors))
  assert.ok(kindErrors.some((message) => message.includes('install|pack|skill')))

  const missingSource = validProposals()
  delete missingSource.items[1].evidence.source
  assert.ok(failing(schemas.proposals.validate(missingSource)).some((message) => message.includes('source')))

  const missingEffect = validProposals()
  delete missingEffect.items[2].effect
  assert.ok(failing(schemas.proposals.validate(missingEffect)).some((message) => message.includes('effect')))
})

test('proposals：未知字段判错（顶层/item/evidence）', () => {
  const top = validProposals()
  top.generatedBy = 'x'
  assert.ok(failing(schemas.proposals.validate(top)).some((message) => message.includes('未知字段')))

  const item = validProposals()
  item.items[0].score = 0.9
  assert.ok(failing(schemas.proposals.validate(item)).some((message) => message.includes('未知字段') && message.includes('score')))

  const evidence = validProposals()
  evidence.items[0].evidence.trust = 'high'
  assert.ok(failing(schemas.proposals.validate(evidence)).some((message) => message.includes('未知字段')))
})

test('errors 稳定：同一输入两次校验产生相同的独立错误数组', () => {
  const bad = validScan()
  bad.tools[0].used30d = 'x'
  const first = schemas.scan.validate(bad)
  const second = schemas.scan.validate(bad)
  assert.deepEqual(second.errors, first.errors)
  assert.notStrictEqual(second.errors, first.errors, '每次校验返回独立数组')
})
