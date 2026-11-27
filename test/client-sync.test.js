import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { BUILTIN_SCENARIOS } from '../lib/scenarios.js'

/**
 * F7 static sync tests. client.js is a plain browser artifact mounted through the
 * host module loader (no build step, has no import of host modules), so it cannot
 * be imported in Node. These tests read the source text and assert the two
 * duplicated contracts stay in sync: the version constant vs package.json, and
 * the six scenario chips vs lib/scenarios.js. S2 (2026-11-28) adds opt-in skill
 * install + pack-aware draft static assertions. S3 (2026-11-28) adds the
 * experimental constrained-worker dispatch (pack dispatch + toolFaceApplied) and
 * the real-machine skill probe wording, plus 10-tool / README / DEMO sync.
 */

const ROOT = new URL('../', import.meta.url)

/** @returns {Promise<string>} client.js source text */
async function readClientSource() {
  return readFile(new URL('client.js', ROOT), 'utf8')
}

test('client.js：PLUGIN_VERSION 与 package.json 的 version 一致', async () => {
  const source = await readClientSource()
  const match = /var PLUGIN_VERSION = '([^']+)'/.exec(source)
  assert.ok(match !== null, 'client.js 必须声明 PLUGIN_VERSION 字面量')
  const manifest = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'))
  assert.equal(match[1], manifest.version)
})

test('client.js：SCENARIOS 六个 id/title 与 lib/scenarios.js 内置场景一致', async () => {
  const source = await readClientSource()
  const start = source.indexOf('var SCENARIOS = [')
  assert.ok(start >= 0, 'client.js 必须声明 SCENARIOS 数组')
  const end = source.indexOf('\n  ]', start)
  assert.ok(end > start, 'SCENARIOS 数组必须有结束标记')
  const block = source.slice(start, end)
  const rows = [...block.matchAll(/\{ id: '([^']+)', title: '([^']+)' \}/g)].map((match) => ({
    id: match[1],
    title: match[2],
  }))
  assert.equal(rows.length, 6, '内置场景必须恰好 6 个')
  assert.deepEqual(rows, BUILTIN_SCENARIOS.map((scenario) => ({ id: scenario.id, title: scenario.title })))
})

test('client.js（F7）：装配清单结果区文案改为提案/落盘提示，不再渲染空路径', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('已生成装配清单提案（等待预览/应用）'), '标题必须改成装配清单提案语义')
  assert.ok(source.includes('packs/<id>.json'), '必须提示应用成功后才写入 packs/<id>.json')
  assert.equal(source.includes("'路径：'"), false, 'R-PACK 后 /pack 不再返回 path，空路径行必须删除')
  assert.equal(source.includes('工具包已生成'), false, '旧标题必须删除')
})

test('client.js（F7）：usageUnknown 对空工具列表不得判未知（加长度保护）', async () => {
  const source = await readClientSource()
  const start = source.indexOf('function usageUnknown(scan) {')
  assert.ok(start >= 0, 'client.js 必须保留 usageUnknown')
  const end = source.indexOf('\n  }', start)
  const body = source.slice(start, end)
  assert.ok(body.includes('scan.tools.length === 0) return false'), '空 tools 返回 false（有扫描结果、只是没有工具）')
  assert.ok(body.includes('Array.isArray(scan.tools)'), '非数组仍判未知')
})

test('client.js（F7）：custom 截断按码点（Array.from），与 lib/scenarios.js 一致', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('function truncateByCodePoints('), '必须有按码点截断的 helper')
  assert.ok(source.includes('Array.from(text)'), 'helper 必须按码点切分')
  assert.ok(source.includes('truncateByCodePoints(value, CUSTOM_MAX_CHARS)'), 'onChange 必须用 helper 且上限复用 CUSTOM_MAX_CHARS')
})
test('client.js（后台派单）：按钮、dispatch 路由、availability 降级与查看会话', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('让 Agent 后台拆解'))
  assert.ok(source.includes("apiRequest('dispatch'"))
  assert.ok(source.includes("body: { kind: 'map' }"))
  assert.ok(source.includes('dispatchSupported'))
  assert.ok(source.includes('后台执行中'))
  assert.ok(source.includes('查看后台会话'))
  assert.ok(source.includes("panelContext.get('uiWorkspace', false)"))
  assert.ok(source.includes('stow_map_save'))
})

test('client.js（后台派单）：自定义场景可派单，openSession 只在显式点击处', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('填写自定义场景'))
  const openAt = source.indexOf('function onOpenDispatchSession')
  assert.ok(openAt >= 0, '必须存在 onOpenDispatchSession')
  assert.equal(source.slice(0, openAt).includes('openSession'), false, 'openSession 不得出现在渲染/自动路径')
  assert.ok(source.slice(openAt).includes('openSession'), '点击处理里应调用 openSession')
})

test('client.js（UX）：三屏标签为 整理/场景/工作流，扫描技术告警折叠为用户可读摘要', async () => {
  const source = await readClientSource()
  assert.ok(source.includes("{ id: 'clean', title: '整理' }"))
  assert.ok(source.includes("{ id: 'scenarios', title: '场景' }"))
  assert.ok(source.includes("{ id: 'map', title: '工作流' }"))
  assert.ok(source.includes('renderScanWarnings'))
  assert.ok(source.includes('技术详情（'))
  assert.ok(source.includes('不影响使用'))
  assert.ok(source.includes('不会当成 0'))
  assert.equal(source.includes("'地图操作'"), false)
})

test('client.js（一键整理）：按钮、pipeline 路由与结果摘要（到预览即止）', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('一键整理'))
  assert.ok(source.includes("apiRequest('pipeline'"))
  assert.ok(source.includes("kind: 'pipeline'"))
  assert.equal(source.includes('已自动应用'), false, 'pipeline 不再自动应用：不得出现「已自动应用」')
  const start = source.indexOf('function onPipeline() {')
  const end = source.indexOf('function onGaps()', start)
  assert.ok(start >= 0 && end > start, '必须能定位 onPipeline')
  assert.ok(
    source.slice(start, end).includes("message: '一键整理完成（已到预览，未写入文件）'"),
    '状态行文案必须说明已到预览、未写入文件',
  )
})

test('client.js（技能安装 opt-in）：工作流操作区有安装复选框，默认不勾选', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('var installSkillHook = useState(false)'), '勾选状态默认必须是 false（opt-in）')
  assert.ok(source.includes('var installSkill = installSkillHook[0]'), '必须有 installSkill 状态')
  assert.ok(source.includes('function onInstallSkillChange(event) {'), '必须有复选框变更处理')
  assert.ok(source.includes("type: 'checkbox'"), '工作流操作区必须有复选框')
  assert.ok(source.includes('checked: installSkill'), '复选框必须绑定 installSkill 状态')
  assert.ok(source.includes('onChange: onInstallSkillChange'), '复选框必须绑定变更处理')
  assert.ok(
    source.includes('应用时安装工作流技能（写入 $DSH_HOME/skills，默认不装，可回滚）'),
    '复选框文案必须写明默认不装、可回滚',
  )
  const actionsStart = source.indexOf('function renderMapActions() {')
  const actionsEnd = source.indexOf('function renderMap()', actionsStart)
  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart, '必须能定位 renderMapActions')
  const block = source.slice(actionsStart, actionsEnd)
  assert.ok(block.includes('installSkill'), '复选框必须渲染在工作流操作区（renderMapActions）')
  assert.ok(block.includes('gz-install-skill'), '复选框必须有稳定 id')
})

test('client.js（技能安装 opt-in）：onApply 把勾选状态作为 installSkill 布尔值传给 /apply', async () => {
  const source = await readClientSource()
  const start = source.indexOf('function onApply() {')
  const end = source.indexOf('function onSnapshotChange', start)
  assert.ok(start >= 0 && end > start, '必须能定位 onApply')
  const block = source.slice(start, end)
  assert.ok(block.includes('body: { ids: ids, installSkill: installSkill === true }'), 'onApply 的 body 必须带 installSkill 布尔值')
  assert.equal(block.includes('body: { ids: ids }'), false, '不得再传不带 installSkill 的旧 body')
})

test('client.js（技能安装 opt-in）：apply 结果卡按本次勾选状态区分空 skills 提示', async () => {
  const source = await readClientSource()
  const start = source.indexOf("result.kind === 'apply'")
  const end = source.indexOf("result.kind === 'rollback'", start)
  assert.ok(start >= 0 && end > start, '必须能定位 apply 结果卡')
  const block = source.slice(start, end)
  assert.ok(block.includes('payload.skills'), 'apply 结果卡必须读取 payload.skills')
  assert.ok(block.includes('已安装工作流技能（$DSH_HOME/skills'), '非空 skills 必须列出技能并注明位置')
  assert.ok(block.includes('可回滚'), '非空 skills 必须注明可回滚')
  assert.ok(block.includes('result.installSkill'), '空 skills 提示必须按本次勾选状态区分（取结果卡快照）')
  assert.ok(
    block.includes('本次只导出装配清单，未安装技能（勾选「应用时安装工作流技能」可安装）'),
    '未勾选时提示默认只导出、如何安装',
  )
  assert.ok(
    block.includes('本次未安装技能（清单为空或技能目录不可用，见警告）'),
    '勾选但为空时提示原因见警告',
  )
  assert.equal(block.includes('DSH 热加载'), false, '真机热加载 not-run，不得在结果卡宣称已热加载')
  const appliedAt = block.indexOf('已应用 ')
  const snapshotAt = block.indexOf('快照 id（已填入回滚框）')
  const skillsAt = block.indexOf('payload.skills')
  assert.ok(appliedAt >= 0 && snapshotAt > appliedAt, '必须先显示已应用条数与 snapshotId')
  assert.ok(skillsAt > snapshotAt, '技能结果必须排在 snapshotId 之后')
  assert.ok(block.includes('skill.name'), '必须逐条按 name 渲染技能名')
})

test('client.js（技能安装 opt-in）：pack 结果卡默认只导出，安装是勾选分支且默认不进模型技能目录', async () => {
  const source = await readClientSource()
  assert.equal(source.includes('已自动应用'), false, '不得出现「已自动应用」')
  assert.equal(source.includes('自动应用'), false, '全文件不得出现「自动应用」字样')
  assert.equal(source.includes('生成工具包'), false, '旧按钮文案「生成工具包」必须删除')
  const start = source.indexOf("result.kind === 'pack'")
  const end = source.indexOf("result.kind === 'preview'", start)
  assert.ok(start >= 0 && end > start, '必须能定位 pack 结果卡')
  const block = source.slice(start, end)
  assert.ok(block.includes('应用时默认只导出 packs/<id>.json'), 'pack 卡必须说明应用时默认只导出')
  assert.ok(block.includes('$DSH_HOME/skills/stow-<id>/SKILL.md'), '必须写明勾选安装时的技能路径')
  assert.ok(block.includes('disable-model-invocation: true'), '必须说明生成技能默认 disable-model-invocation: true')
  assert.ok(block.includes('不进模型技能目录'), '必须说明默认不进模型技能目录')
  assert.ok(block.includes('可回滚'), '必须说明技能安装可回滚')
  assert.equal(block.includes('应用成功后导出'), false, '不得再声称应用成功后必导出并安装')
  assert.equal(block.includes('并安装工作流技能 stow-<id>'), false, '不得再声称应用即安装技能')
  assert.equal(block.includes('DSH 热加载，无需重启'), false, '真机热加载 not-run，不得宣称无需重启')
  assert.ok(
    block.includes('renderWarningDetails(payload.warnings'),
    'pack 结果卡必须渲染 /pack 返回的 warnings（空包会告警）',
  )
})

test('client.js（一键整理到预览）：结果卡展示预览数量/hash/快照 id，提示默认只导出', async () => {
  const source = await readClientSource()
  const start = source.indexOf("result.kind === 'pipeline'")
  const end = source.indexOf("result.kind === 'draft'", start)
  assert.ok(start >= 0 && end > start, '必须能定位 pipeline 结果卡')
  const block = source.slice(start, end)
  assert.equal(block.includes('payload.apply'), false, 'pipeline 响应已无 apply 字段，结果卡不得读取')
  assert.equal(block.includes('自动应用'), false, 'pipeline 结果卡不得再宣称自动应用')
  assert.ok(block.includes('payload.preview'), '必须读取 payload.preview')
  assert.ok(block.includes('itemCount'), '必须展示 preview.itemCount')
  assert.ok(block.includes('hash'), '必须展示 preview.hash')
  assert.ok(block.includes('已建快照'), '必须说明已建快照')
  assert.ok(block.includes('snapshotId'), '必须展示 snapshotId')
  assert.ok(block.includes('应用时默认只导出'), '必须提示应用时默认只导出装配清单')
  assert.ok(block.includes('才会写技能目录'), '必须提示勾选安装技能才会写技能目录')
  assert.ok(block.includes('一键整理完成（已到预览，未写入文件）'), '标题必须说明已到预览、未写入文件')
})

test('client.js（按钮一致性）：工作流按钮与 onPack 动作文案统一为「生成装配清单」', async () => {
  const source = await readClientSource()
  const actionsStart = source.indexOf('function renderMapActions() {')
  const actionsEnd = source.indexOf('function renderMap()', actionsStart)
  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart, '必须能定位 renderMapActions')
  assert.ok(
    source.slice(actionsStart, actionsEnd).includes("onClick: onPack }, '生成装配清单'"),
    '地图操作栏按钮文案必须是「生成装配清单」',
  )
  const packStart = source.indexOf('function onPack() {')
  const packEnd = source.indexOf('function onPreview()', packStart)
  assert.ok(packStart >= 0 && packEnd > packStart, '必须能定位 onPack')
  assert.ok(source.slice(packStart, packEnd).includes("runAction('生成装配清单'"), 'onPack 的忙碌文案必须与按钮一致')
})

test('client.js（一键整理进度）：轮询 pipelineStatus 并渲染圆环百分比', async () => {
  const source = await readClientSource()
  assert.ok(source.includes("apiRequest('pipelineStatus'"))
  assert.ok(source.includes('renderPipelineProgress'))
  assert.ok(source.includes('strokeDashoffset'))
  assert.ok(source.includes('gz-ring-value'))
  assert.ok(source.includes("data-state"))
  assert.ok(source.includes('一键整理进度 '))
})

test('client.js（目录源）：工作流页可填目录源并保存', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('目录源'))
  assert.ok(source.includes("apiRequest('sources'"))
  assert.ok(source.includes('renderSources'))
  assert.ok(source.includes('目录源 URL'))
  assert.ok(source.includes('推荐源'))
  assert.ok(source.includes('保存目录源'))
})

test('client.js（推荐源）：预置源只填入输入框，不自动保存、不主动请求', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('SOURCE_PRESETS'), 'client.js 必须声明 SOURCE_PRESETS')
  assert.ok(source.includes('https://dshopen.org/index.json'), 'dshopen 必须在推荐源里')
  assert.ok(
    source.includes('https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'),
    'jsDelivr 精选索引必须在推荐源里',
  )
  assert.ok(source.includes('第三方'), '推荐源必须标注第三方')
  const start = source.indexOf('function applySourcePreset')
  assert.ok(start >= 0, '必须有 applySourcePreset')
  const end = source.indexOf('function renderSources', start)
  assert.ok(end > start, 'applySourcePreset 必须在 renderSources 之前')
  const block = source.slice(start, end)
  assert.ok(block.includes('setSourceDraft'), '推荐源只能改输入框草稿')
  assert.equal(block.includes('apiRequest'), false, '推荐源不得发请求')
  assert.equal(block.includes('saveSource'), false, '推荐源不得自动保存')
})

test('client.js（精简建议）：展开冗余能力点时先渲染建议块，再列证据', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('function capabilityKey('), '必须有与服务端 advice 对齐的 key helper')
  assert.ok(source.includes('function adviceLookup('), '必须消费 GET state 的 advice 视图')
  assert.ok(source.includes('function renderCapabilityAdvice('), '必须有精简建议渲染器')
  assert.ok(source.includes("className: 'gz-advice'"), '必须有建议块的样式类')
  assert.ok(source.includes('精简建议'), '文案必须出现「精简建议」')
  assert.ok(source.includes('data.advice'), '建议来自 GET state 的 advice 字段')
  assert.ok(source.includes("origin: '来源类型'"), 'origin 证据键必须有中文标签')
  assert.ok(source.includes("overlap: '重叠说明'"), 'overlap 证据键必须有中文标签')
  const mapStart = source.indexOf('function renderMap() {')
  const mapEnd = source.indexOf('function renderBody()', mapStart)
  assert.ok(mapStart >= 0 && mapEnd > mapStart, '必须能定位 renderMap')
  const block = source.slice(mapStart, mapEnd)
  const adviceAt = block.indexOf('renderCapabilityAdvice(advice)')
  const evidenceAt = block.indexOf('gz-evidence-grid')
  assert.ok(adviceAt >= 0, 'renderMap 必须渲染建议块')
  assert.ok(evidenceAt >= 0, 'renderMap 仍必须渲染证据网格')
  assert.ok(adviceAt < evidenceAt, '建议块必须排在证据之前')
})

test('client.js（按 pack 派单）：记住最近一次 pack id，onDraft 有 packId 时按该 pack 生成', async () => {
  const source = await readClientSource()
  assert.ok(source.includes("var lastPackIdHook = useState('')"), '必须有最近一次 pack id 的状态')
  assert.ok(source.includes('var lastPackId = lastPackIdHook[0]'), '必须读取 lastPackId')
  assert.ok(source.includes('setLastPackId'), 'pack 成功后必须记录最近 pack id')
  const packStart = source.indexOf('function onPack() {')
  const packEnd = source.indexOf('function onPreview()', packStart)
  assert.ok(packStart >= 0 && packEnd > packStart, '必须能定位 onPack')
  assert.ok(source.slice(packStart, packEnd).includes('setLastPackId'), 'pack 成功时必须 setLastPackId')
  const draftStart = source.indexOf('function onDraft() {')
  const draftEnd = source.indexOf('function onCopyDraft()', draftStart)
  assert.ok(draftStart >= 0 && draftEnd > draftStart, '必须能定位 onDraft')
  const block = source.slice(draftStart, draftEnd)
  assert.ok(block.includes("var body = { kind: 'dispatch' }"), '无 pack 时保持旧的 dispatch body')
  assert.ok(block.includes('body.packId = lastPackId'), '有最近 pack id 时 onDraft 必须把它传给 /draft')
  assert.ok(block.includes("apiRequest('draft'"), 'onDraft 必须调用 draft 路由')
})

test('client.js（按 pack 派单）：draft 结果卡对 pack 载荷提示父→子软约束、工具面未被硬限制', async () => {
  const source = await readClientSource()
  const start = source.indexOf("result.kind === 'draft'")
  const end = source.indexOf("result.kind === 'dispatch'", start)
  assert.ok(start >= 0 && end > start, '必须能定位 draft 结果卡')
  const block = source.slice(start, end)
  assert.ok(block.includes('result.packId'), 'draft 卡必须区分按 pack 生成的载荷')
  assert.ok(block.includes('父→子软约束'), '必须提示这是按装配清单生成的父→子软约束')
  assert.ok(block.includes('工具面未被硬限制'), '必须如实说明工具面未被硬限制')
  assert.ok(block.includes('不删工具 schema'), '必须说明不删工具 schema')
  assert.ok(block.includes('不省工具面 token'), '必须说明不省工具面 token')
})

test('client.js（S2 收尾）：全文无「应用即安装」「自动应用」及未验证的热加载宣称', async () => {
  const source = await readClientSource()
  assert.equal(source.includes('应用即安装'), false, '不得写「应用即安装」')
  assert.equal(source.includes('自动应用'), false, '不得写「自动应用」')
  assert.equal(source.includes('已自动应用'), false, '不得写「已自动应用」')
  assert.equal(source.includes('应用成功后导出'), false, '安装是 opt-in：不得写「应用成功后导出」')
  assert.equal(source.includes('无需重启'), false, '真机热加载 not-run：不得宣称无需重启')
  assert.equal(source.includes('热加载已生效'), false, '不得宣称热加载已生效')
  assert.equal(source.includes('应用时自动'), false, '技能安装必须 opt-in，不得写自动安装')
  const claim = /(^|[^不])限制工具面/.exec(source)
  assert.equal(claim, null, '不得宣称限制工具面（只允许「不限制工具面」这类否定说明）')
  assert.ok(source.includes('应用时默认只导出'), '必须明确应用时默认只导出')
  assert.ok(source.includes('disable-model-invocation: true'), '必须说明生成技能默认 disable-model-invocation: true')
})

test('client.js（S3 受限 worker）：操作区「派发受限子代理」按钮按 lastPackId 派发 pack', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('派发受限子代理'), '工作流操作区必须有「派发受限子代理」按钮')
  const actionsStart = source.indexOf('function renderMapActions() {')
  const actionsEnd = source.indexOf('function renderMap()', actionsStart)
  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart, '必须能定位 renderMapActions')
  const actions = source.slice(actionsStart, actionsEnd)
  assert.ok(actions.includes('onDispatchPack'), '按钮必须绑定 onDispatchPack')
  assert.ok(actions.includes("lastPackId === ''"), '无最近 pack id 时必须禁用 / 提示')
  assert.ok(actions.includes('先生成装配清单'), '无 pack 时必须提示先生成装配清单')
  assert.ok(actions.includes('10 个 stow_*'), '操作区文案必须同步 10 个 stow_* 工具')
  const start = source.indexOf('function onDispatchPack() {')
  const end = source.indexOf('function onOpenDispatchSession', start)
  assert.ok(start >= 0 && end > start, '必须能定位 onDispatchPack')
  const handler = source.slice(start, end)
  assert.ok(handler.includes("apiRequest('dispatch'"), '必须调用 dispatch 路由')
  assert.ok(handler.includes("body: { kind: 'pack', packId: packId }"), 'pack 派发 body 必须带 kind=pack 与 packId')
  assert.ok(handler.includes('lastPackId'), 'packId 必须来自最近一次装配清单')
  assert.equal(handler.includes('openSession'), false, '派发处理不得自动打开会话')
})

test('client.js（S3 受限 worker）：结果卡展示 worker 会话 / toolFaceApplied / warnings 与实验性限制', async () => {
  const source = await readClientSource()
  const start = source.indexOf("result.kind === 'dispatchPack'")
  assert.ok(start >= 0, '必须有派发受限 worker 的结果卡分支')
  const end = source.indexOf('return null', start)
  assert.ok(end > start, '必须能定位结果卡结束')
  const block = source.slice(start, end)
  assert.ok(block.includes('worker 会话'), '结果卡必须展示 worker 会话 sessionId')
  assert.ok(block.includes('toolFaceApplied'), '结果卡必须展示 toolFaceApplied')
  assert.ok(block.includes('只说明 restrict 被调用'), 'toolFaceApplied 只代表 restrict 被调用')
  assert.ok(block.includes('report.visible'), '必须指出 report.visible 才是实际证据')
  assert.equal(block.includes('工具面限制已生效'), false, '不得把 toolFaceApplied 写成「已生效」')
  assert.ok(block.includes('payload.toolFace'), '结果卡必须读取 toolFace.requested 等字段')
  assert.ok(block.includes('renderWarningDetails(payload.warnings'), '结果卡必须展示 warnings')
  assert.ok(block.includes('实验性、尽力而为'), '必须标注实验性、尽力而为')
  assert.ok(block.includes('run_code'), '必须说明 run_code 可能仍可见')
  assert.ok(block.includes('可能仍可见'), '必须说明清单外工具可能仍可见')
  assert.ok(block.includes('stow_dispatch'), '必须说明与会话内 stow_dispatch 同一实现')
  assert.equal(block.includes('已隔离工具'), false, '不得宣称已隔离工具')
})

test('client.js（S3）：toolFace.report.visible 结果卡渲染实际可见工具（前 12 个 + 计数 + 实测证据语义）', async () => {
  const source = await readClientSource()
  const start = source.indexOf("result.kind === 'dispatchPack'")
  const end = source.indexOf('return null', start)
  assert.ok(start >= 0 && end > start, '必须能定位 dispatchPack 结果卡')
  const block = source.slice(start, end)
  assert.ok(block.includes('toolFace.report'), '结果卡必须读取 toolFace.report')
  assert.ok(block.includes('toolFaceReport.visible'), '结果卡必须读取 report.visible')
  assert.ok(block.includes('实际可见工具（restrict 后）'), '必须展示「实际可见工具（restrict 后）」')
  assert.ok(block.includes('slice(0, 12)'), 'visible 列表最多展示前 12 个')
  assert.ok(block.includes('省略'), '超出前 12 个必须有省略提示')
  for (const field of ['allowed', 'skipped', 'leaked']) {
    assert.ok(block.includes('toolFaceReport.' + field), '必须展示 report.' + field + ' 计数')
  }
  assert.ok(block.includes('实测'), '必须说明 report.visible 是实测证据')
  assert.ok(block.includes('不是「严格 N 个工具」的承诺'), '必须说明不是严格 N 的承诺')
  assert.ok(block.includes('run_code'), '必须说明 run_code 可能仍可见')
  assert.ok(block.includes('宿主豁免工具'), '必须说明宿主豁免工具可能仍可见')
  assert.equal(block.includes('严格只带'), false, '不得出现「严格只带」')
  assert.equal(block.includes('已隔离工具'), false, '不得出现「已隔离工具」')
})

test('client.js（S3）：toolFace.report 为 null 时不伪造可见工具列表，按 warnings 说明', async () => {
  const source = await readClientSource()
  const start = source.indexOf("result.kind === 'dispatchPack'")
  const end = source.indexOf('return null', start)
  const block = source.slice(start, end)
  assert.ok(block.includes('toolFace.report !== null'), '必须显式判断 report 是否存在')
  const ifPos = block.indexOf('if (toolFaceReport !== null)')
  const titlePos = block.indexOf('实际可见工具（restrict 后）')
  const nullTextPos = block.indexOf('未取到宿主实测报告')
  assert.ok(ifPos >= 0 && titlePos > ifPos, '可见工具列表必须在 report 存在的分支里渲染')
  assert.ok(nullTextPos > titlePos, 'report 为 null 的分支必须说明未取到，且不在 visible 列表里')
  assert.ok(block.includes('不伪造'), 'report 为空时不得伪造列表')
  assert.ok(block.includes('warnings'), 'report 为空时应引导看 warnings')
})

test('client.js（S3 技能探针）：安装提示写明当前会话未刷新、新会话/重启后才可能可见、未完全验证', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('当前会话的技能列表没有刷新'), '必须写入真机探针结论：当前会话技能列表没有刷新')
  assert.ok(source.includes('skills 总数不变'), '探针必须说明技能数量不变（skills 总数不变）')
  assert.ok(source.includes('新会话 / 重启'), '必须说明需要新会话 / 重启')
  assert.ok(source.includes('未完全验证'), '必须如实标注未完全验证')
  assert.equal(source.includes('热加载已生效'), false, '不得宣称热加载已生效')
  assert.equal(source.includes('无需重启'), false, '不得宣称无需重启')
  const packStart = source.indexOf("result.kind === 'pack'")
  const packEnd = source.indexOf("result.kind === 'preview'", packStart)
  assert.ok(packStart >= 0 && packEnd > packStart, '必须能定位 pack 结果卡')
  assert.ok(source.slice(packStart, packEnd).includes('当前会话的技能列表没有刷新'), 'pack 卡必须带探针结论')
  const applyStart = source.indexOf("result.kind === 'apply'")
  const applyEnd = source.indexOf("result.kind === 'rollback'", applyStart)
  assert.ok(applyStart >= 0 && applyEnd > applyStart, '必须能定位 apply 结果卡')
  assert.ok(source.slice(applyStart, applyEnd).includes('未完全验证'), 'apply 卡技能提示必须带未完全验证')
})

test('client.js（S3）：全文不出现「已隔离工具」「严格只带」「热加载无需重启」等不实措辞', async () => {
  const source = await readClientSource()
  const banned = ['已隔离工具', '严格只带', '热加载无需重启', '无需重启', '热加载已生效', '工具面已隔离', '严格限制到']
  for (const phrase of banned) assert.equal(source.includes(phrase), false, '不得出现「' + phrase + '」')
  assert.ok(source.includes('10 个 stow_*'), '必须同步 10 个 stow_* 工具数量')
})

test('S3：10 个 stow_* 工具在 client / README / DEMO 同步（含 stow_dispatch）', async () => {
  const source = await readClientSource()
  const readme = await readFile(new URL('README.md', ROOT), 'utf8')
  const demo = await readFile(new URL('docs/DEMO.md', ROOT), 'utf8')
  const names = [
    'stow_scan',
    'stow_status',
    'stow_map_save',
    'stow_pack_build',
    'stow_gaps',
    'stow_preview',
    'stow_apply',
    'stow_rollback',
    'stow_draft',
    'stow_dispatch',
  ]
  for (const name of names) {
    assert.ok(readme.includes('`' + name + '`'), 'README 工具表必须列出 ' + name)
    assert.ok(demo.includes(name), 'DEMO 必须列出 ' + name)
  }
  assert.ok(readme.includes('10 个 `stow_*`'), 'README 必须写明 10 个 stow_* 工具')
  assert.ok(demo.includes('10 个 stow_*'), 'DEMO 必须写明 10 个 stow_* 工具')
  assert.ok(source.includes('10 个 stow_*'), 'client 文案必须同步 10 个 stow_* 工具')
  assert.ok(source.includes('stow_dispatch'), 'client 必须说明与 stow_dispatch 同一实现')
})

test('S3：README / DEMO 同步磁盘技能补扫（host 优先、按 name 去重）与 toolFace.report.visible 实测字段', async () => {
  const readme = await readFile(new URL('README.md', ROOT), 'utf8')
  const demo = await readFile(new URL('docs/DEMO.md', ROOT), 'utf8')
  for (const [label, text] of [['README', readme], ['DEMO', demo]]) {
    assert.ok(text.includes('toolFace.report'), label + ' 必须写 toolFace.report')
    assert.ok(text.includes('report.visible'), label + ' 必须写 report.visible')
    assert.ok(text.includes('实测'), label + ' 必须说明这是实测字段')
    assert.ok(text.includes('不伪造'), label + ' 必须说明 report=null 不伪造')
  }
  assert.ok(readme.includes('磁盘'), 'README 必须说明技能清单磁盘补扫')
  assert.ok(readme.includes('host 优先'), 'README 必须说明 host 行优先合并')
  assert.ok(readme.includes('按 name 去重'), 'README 必须说明按 name 去重')
  assert.ok(demo.includes('磁盘'), 'DEMO 必须说明技能清单磁盘补扫')
  assert.ok(demo.includes('host 优先'), 'DEMO 必须说明 host 优先')
})

test('README / DEMO：测试计数一致（badge / 开发命令 / 状态），不残留旧计数 465', async () => {
  const readme = await readFile(new URL('README.md', ROOT), 'utf8')
  const demo = await readFile(new URL('docs/DEMO.md', ROOT), 'utf8')
  const digitsOnly = (text) => text.split('').filter((ch) => ch >= '0' && ch <= '9').join('')
  const numberBetween = (text, before, after) => {
    const start = text.indexOf(before)
    if (start < 0) return ''
    const from = start + before.length
    const end = text.indexOf(after, from)
    return end < 0 ? '' : digitsOnly(text.slice(from, end))
  }
  const badge = numberBetween(readme, 'badge/tests-', '%20passing')
  const dev = numberBetween(readme, 'node --test test/*.test.js', '个测试')
  const demoFullStart = demo.indexOf('全量：')
  const demoFull = demoFullStart < 0 ? '' : digitsOnly(demo.slice(demoFullStart + 3, demo.indexOf('通过', demoFullStart)))
  const statusAt = readme.indexOf('测试通过')
  const statusSlash = statusAt < 0 ? -1 : readme.lastIndexOf('/', statusAt)
  let statusFirst = ''
  let statusSecond = ''
  if (statusSlash >= 0) {
    let start = statusSlash - 1
    while (start >= 0 && readme[start] >= '0' && readme[start] <= '9') start -= 1
    let end = statusSlash + 1
    while (end < readme.length && readme[end] >= '0' && readme[end] <= '9') end += 1
    statusFirst = readme.slice(start + 1, statusSlash)
    statusSecond = readme.slice(statusSlash + 1, end)
  }
  assert.ok(badge !== '', 'README badge 必须写测试计数')
  assert.ok(dev !== '', 'README 开发命令必须写测试计数')
  assert.ok(demoFull !== '', 'DEMO 验证命令必须写全量 N/N')
  assert.ok(statusFirst !== '' && statusFirst === statusSecond, 'README 状态段必须写 N/N 测试通过')
  assert.equal(dev, badge, '开发命令计数必须与 badge 一致')
  assert.equal(statusFirst, badge, '状态段计数必须与 badge 一致')
  assert.equal(demoFull.slice(0, demoFull.length / 2), badge, 'DEMO 计数必须与 README 一致')
  assert.notEqual(badge, '465', '不得残留旧计数 465')
})

test('S3：README / DEMO 写明 dispatch kind map/pack + packId、降级矩阵、真机 not-run 与技能探针结论', async () => {
  const readme = await readFile(new URL('README.md', ROOT), 'utf8')
  const demo = await readFile(new URL('docs/DEMO.md', ROOT), 'utf8')
  assert.ok(readme.includes('实验性：受限 worker'), 'README 必须有「实验性：受限 worker」小节')
  assert.ok(readme.includes('agent.ctx.tools.restrict'), 'README 必须写机制 agent.ctx.tools.restrict({ allow })')
  assert.ok(readme.includes('toolFaceApplied'), 'README 必须写 toolFaceApplied')
  assert.ok(readme.includes("kind: 'map' | 'pack'"), 'README 必须说明 dispatch 的 kind map/pack')
  assert.ok(readme.includes('packId'), 'README 必须说明 pack 时传 packId')
  assert.ok(readme.includes('503'), 'README 降级矩阵必须含 503')
  assert.ok(readme.includes('502'), 'README 降级矩阵必须含 502')
  assert.ok(readme.includes('不承诺严格 N'), 'README 必须明确 v1 不承诺严格 N')
  assert.ok(demo.includes('toolFaceApplied'), 'DEMO 必须演示 toolFaceApplied')
  assert.ok(demo.includes('受限 worker 工具面'), 'DEMO not-run 清单必须含受限 worker 工具面')
  assert.ok(demo.includes('技能新会话可见性'), 'DEMO not-run 清单必须含技能新会话可见性')
  assert.ok(demo.includes('32→32'), 'DEMO 必须写入真机技能探针结果 32→32')
  for (const [label, text] of [['README', readme], ['DEMO', demo]]) {
    for (const phrase of ['热加载无需重启', '无需重启', '已隔离工具', '严格只带', '热加载已生效']) {
      assert.equal(text.includes(phrase), false, label + ' 不得出现「' + phrase + '」')
    }
    assert.equal(/416/.test(text), false, label + ' 不得残留旧的 416 测试计数')
  }
})
