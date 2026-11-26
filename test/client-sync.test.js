import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { BUILTIN_SCENARIOS } from '../lib/scenarios.js'

/**
 * F7 static sync tests. client.js is a plain browser artifact mounted through the
 * host module loader (no build step, has no import of host modules), so it cannot
 * be imported in Node. These tests read the source text and assert the two
 * duplicated contracts stay in sync: the version constant vs package.json, and
 * the six scenario chips vs lib/scenarios.js.
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

test('client.js（F7）：能力包结果区文案改为提案/落盘提示，不再渲染空路径', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('已生成能力包提案（等待预览/应用）'), '标题必须改成提案语义')
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

test('client.js（一键整理）：按钮、pipeline 路由与结果摘要', async () => {
  const source = await readClientSource()
  assert.ok(source.includes('一键整理'))
  assert.ok(source.includes("apiRequest('pipeline'"))
  assert.ok(source.includes("kind: 'pipeline'"))
  assert.ok(source.includes('已自动应用'))
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




