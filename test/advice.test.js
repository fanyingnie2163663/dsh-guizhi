import test from 'node:test'
import assert from 'node:assert/strict'
import { ADVICE_HINT, ADVICE_TITLE, TRIM_TITLE, buildAdvice, capabilityAdvice, usageIndex } from '../lib/advice.js'

/** 最小 D7 scan；只关心 tools，其余字段给空值以免误导。 */
function scanWithTools(tools) {
  return {
    plugins: [],
    tools,
    skills: [],
    totals: { plugins: 0, tools: tools.length, skills: 0, unusedTools: 0 },
    warnings: [],
    generatedAt: '2026-11-27T00:00:00.000Z',
  }
}

/** 一个冗余能力点；用 overrides 覆盖单个字段。 */
function redundantCapability(overrides = {}) {
  return { id: 'web-design', title: '网页视觉', status: 'redundant', evidence: {}, ...overrides }
}

/** 单阶段 + 单能力点的地图。 */
function mapWith(capability) {
  return { scenarios: ['design'], stages: [{ id: 'create', title: '内容与视觉', capabilities: [capability] }] }
}

/** 两个插件名下各一个工具：一个近 30 天 5 次，一个已知 0 次。 */
function knownUsage() {
  return usageIndex(
    scanWithTools([
      { name: 'artifact_tool', description: 'd', owners: ['dsh-web-artifact-designer'], used30d: 5, lastUsedAt: null },
      { name: 'frontend_tool', description: 'd', owners: ['dsh-frontend-design'], used30d: 0, lastUsedAt: null },
    ]),
  )
}

test('buildAdvice：没有地图 / 地图不合法时返回空 items，不抛错', () => {
  const cases = [undefined, null, {}, { map: null }, { map: { stages: 'nope' } }, { map: { stages: [null, 1, {}] } }]
  for (const input of cases) {
    assert.deepEqual(buildAdvice(input), { items: [] }, JSON.stringify(input))
  }
})

test('capabilityAdvice：地图里的 suggestion 原文优先，并标记来源为 map', () => {
  const capability = redundantCapability({ suggestion: '  保留 frontend-design，把另一个移出常用工作流。  ' })
  const item = capabilityAdvice({ stageId: 'create', capability, usage: knownUsage() })
  assert.equal(item.text, '保留 frontend-design，把另一个移出常用工作流。')
  assert.equal(item.title, TRIM_TITLE)
  assert.equal(item.source, 'map')
  assert.equal(item.stageId, 'create')
  assert.equal(item.capabilityId, 'web-design')
  assert.match(item.hint, /工作流地图/)
  assert.ok(item.hint.includes(ADVICE_HINT), '建议必须带「只给建议」提示')
})

test('capabilityAdvice：非冗余且无 suggestion 的能力点不生成建议', () => {
  for (const status of ['have', 'missing']) {
    assert.equal(capabilityAdvice({ stageId: 's', capability: redundantCapability({ status }), usage: knownUsage() }), null)
  }
})

test('capabilityAdvice：显式 suggestion 也可用于非冗余能力点，标题为「建议」', () => {
  const item = capabilityAdvice({
    stageId: 's',
    capability: redundantCapability({ status: 'missing', suggestion: '可从目录装一个搜索插件。' }),
    usage: knownUsage(),
  })
  assert.equal(item.title, ADVICE_TITLE)
  assert.equal(item.source, 'map')
  assert.equal(item.text, '可从目录装一个搜索插件。')
})

test('capabilityAdvice：只有空白的 suggestion 视为未填写，回落为自动归纳', () => {
  const item = capabilityAdvice({
    stageId: 's',
    capability: redundantCapability({ suggestion: '   ', evidence: { skills: ['a', 'b'] } }),
    usage: usageIndex(scanWithTools([])),
  })
  assert.equal(item.source, 'derived')
})

test('buildAdvice：按 evidence 的技能与插件派生精简建议（已知用量可给出保留依据）', () => {
  const capability = redundantCapability({
    evidence: {
      source: 'skill',
      skills: ['web-artifact-designer', 'frontend-design'],
      plugins: ['dsh-web-artifact-designer', 'dsh-frontend-design'],
      overlap: '两者都覆盖网页视觉稿/前端界面设计',
    },
  })
  const { items } = buildAdvice({
    map: mapWith(capability),
    scan: scanWithTools([
      { name: 'artifact_tool', description: 'd', owners: ['dsh-web-artifact-designer'], used30d: 5, lastUsedAt: null },
      { name: 'frontend_tool', description: 'd', owners: ['dsh-frontend-design'], used30d: 0, lastUsedAt: null },
    ]),
  })
  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.title, TRIM_TITLE)
  assert.equal(item.source, 'derived')
  assert.match(item.text, /web-artifact-designer、frontend-design/)
  assert.match(item.text, /覆盖同一能力/)
  assert.match(item.text, /保留一个/)
  assert.match(item.text, /dsh-web-artifact-designer 名下工具近 30 天 5 次/)
  assert.match(item.text, /dsh-frontend-design 名下工具近 30 天 0 次/)
  assert.match(item.text, /可优先保留 dsh-web-artifact-designer/)
  assert.match(item.text, /0 次不代表无用/)
  assert.equal(item.hint.startsWith('按地图证据与扫描用量自动归纳；'), true)
  assert.ok(item.hint.includes(ADVICE_HINT))
})

test('buildAdvice：用量未知时不写成 0 次，且如实说明无法判断主次', () => {
  const capability = redundantCapability({
    evidence: { source: 'skill', plugins: ['dsh-web-artifact-designer', 'dsh-frontend-design'] },
  })
  const scan = scanWithTools([
    { name: 'artifact_tool', description: 'd', owners: ['dsh-web-artifact-designer'], used30d: null, lastUsedAt: null },
  ])
  const { items } = buildAdvice({ map: mapWith(capability), scan })
  assert.equal(items.length, 1)
  assert.match(items[0].text, /用量未知/)
  assert.match(items[0].text, /无法判断主次/)
  assert.match(items[0].text, /按使用习惯选一个/)
  assert.equal(items[0].text.includes('0 次'), false, '未知用量不得写成 0 次')
})

test('buildAdvice：已知 0 次会明确写 0 并注明「0 次不代表无用」', () => {
  const capability = redundantCapability({ evidence: { source: 'skill', plugins: ['pkg-a', 'pkg-b'] } })
  const scan = scanWithTools([
    { name: 'a_tool', description: 'd', owners: ['pkg-a'], used30d: 0, lastUsedAt: null },
    { name: 'b_tool', description: 'd', owners: ['pkg-b'], used30d: 0, lastUsedAt: null },
  ])
  const { items } = buildAdvice({ map: mapWith(capability), scan })
  assert.match(items[0].text, /pkg-a 名下工具近 30 天 0 次/)
  assert.match(items[0].text, /pkg-b 名下工具近 30 天 0 次/)
  assert.match(items[0].text, /0 次不代表无用/)
})

test('buildAdvice：只命名技能时说明扫描不统计技能用量', () => {
  const capability = redundantCapability({ evidence: { skills: ['web-artifact-designer', 'frontend-design'] } })
  const { items } = buildAdvice({ map: mapWith(capability), scan: scanWithTools([]) })
  assert.match(items[0].text, /技能调用不计入用量/)
  assert.match(items[0].text, /按使用习惯选一个/)
})

test('buildAdvice：没有来源名也给出通用精简建议', () => {
  const { items } = buildAdvice({ map: mapWith(redundantCapability({ evidence: {} })), scan: scanWithTools([]) })
  assert.equal(items.length, 1)
  assert.match(items[0].text, /只保留一个来源/)
  assert.equal(items[0].source, 'derived')
})

test('buildAdvice：混合技能与插件时也把两个来源并列；名称去重、忽略非字符串', () => {
  const capability = redundantCapability({
    evidence: { skill: 'a-skill', plugins: ['a-plugin', 'a-plugin', 7, '   '] },
  })
  const { items } = buildAdvice({ map: mapWith(capability), scan: scanWithTools([]) })
  assert.match(items[0].text, /a-skill、a-plugin/)
  assert.equal((items[0].text.match(/a-plugin/g) || []).length, 1, '重复名称只出现一次')
})

test('buildAdvice：多个阶段按顺序产出，并保留 stageId/capabilityId', () => {
  const map = {
    scenarios: [],
    stages: [
      { id: 'one', title: '一', capabilities: [{ id: 'a', title: 'A', status: 'have', evidence: {} }] },
      { id: 'two', title: '二', capabilities: [redundantCapability({ id: 'b', suggestion: '保留一个。' })] },
    ],
  }
  const { items } = buildAdvice({ map, scan: scanWithTools([]) })
  assert.equal(items.length, 1)
  assert.equal(items[0].stageId, 'two')
  assert.equal(items[0].capabilityId, 'b')
})

test('usageIndex：按 owner 汇总已知次数，未知保持未知，不伪造 0', () => {
  const usage = usageIndex(
    scanWithTools([
      { name: 'a', description: 'd', owners: ['p', 'q'], used30d: 2, lastUsedAt: null },
      { name: 'b', description: 'd', owners: ['p'], used30d: null, lastUsedAt: null },
    ]),
  )
  assert.deepEqual(usage.byPlugin.get('p'), { calls: 2, known: true })
  assert.deepEqual(usage.byPlugin.get('q'), { calls: 2, known: true })
  assert.deepEqual(usage.byTool.get('b'), { calls: null, known: false })
  assert.equal(usage.byPlugin.has('missing'), false)
})

test('usageIndex / buildAdvice：结构异常输入不抛错', () => {
  for (const scan of [undefined, null, 'scan', { tools: 'nope' }, { tools: [null, 1, { name: '' }, { name: 'x', owners: 'nope', used30d: -1 }] }]) {
    assert.doesNotThrow(() => usageIndex(scan))
    assert.doesNotThrow(() => buildAdvice({ map: mapWith(redundantCapability({ evidence: { plugins: ['p'] } })), scan }))
  }
})
