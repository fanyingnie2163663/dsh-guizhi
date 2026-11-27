import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { ROUTE_PATHS, createRoutes } from '../lib/routes.js'
import { summarizeUsage } from '../lib/usage.js'
import { scanFacts } from '../lib/scan.js'
import { normalizeScenarios } from '../lib/scenarios.js'
import { createMap } from '../lib/map.js'
import { matchGaps } from '../lib/catalog.js'
import { buildPack } from '../lib/packs.js'
import { schemas } from '../lib/schemas.js'

/**
 * Task 8 end-to-end acceptance (design §11 #2/#3, D7 + R-4A + R-6A + R-7A +
 * R-PACK).
 *
 * Unlike the per-module suites this file mocks no business module: it runs the
 * real scan/usage/scenarios/map/catalog/packs/apply/store modules over a real
 * on-disk data root (mkdtemp) and drives the real lib/routes.js HTTP handlers
 * (the same handlers lib/index.js mounts). The only fakes are the host adapter
 * (no DSH boot in a test) and the public catalog document (no network).
 *
 * Chain: scan → save scenarios → save map → gaps (incl. the 400 NO_MAP guard)
 *        → pack proposal (R-PACK: /pack only upserts a kind='pack' proposal and
 *          writes no packs file) → preview → apply (snapshot + ledger + pack
 *          file export) → rollback (idempotent, scoped to the apply ledger)
 *        → final state. Every proposal in the chain comes from a real route
 *        call; no fixture is seeded.
 */

/** Fixed clock: every 30-day usage window in this suite is deterministic. */
const NOW = new Date('2026-11-26T08:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Temp data roots removed after the suite. */
const cleanup = []
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
})

/** @param {unknown} value */
function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/** ISO timestamp daysBefore(days) days before the fixed clock. */
function daysBefore(days) {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString()
}

/** Pack view without the build timestamp: createdAt is wall-clock, everything else is deterministic. */
function packWithoutTimestamp(pack) {
  const copy = { ...pack }
  delete copy.createdAt
  return copy
}

/** @param {string} file */
async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** Create a temp $DSH_HOME-equivalent root ($DSH_HOME/guizhi lives under it). */
async function createHome(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(root)
  return root
}

/** Duplicate 'read' owner rows + every tool/call event shape the usage scanner reads. */
const TOOL_ROWS = [
  { name: 'read', description: 'Read a UTF-8 text file', owner: '@deepseek-ai/dsh-tool-fs' },
  { name: 'read', description: 'Read a file from the sidebar', owner: 'dsh-better-sidebar' },
  { name: 'read', description: 'Repeated registration of read', owner: '@deepseek-ai/dsh-tool-fs' },
  { name: 'grep', description: 'Search file contents', owner: '@deepseek-ai/dsh-tool-fs' },
  { name: 'write', description: 'Write a UTF-8 text file', owner: '@deepseek-ai/dsh-tool-fs' },
  { name: 'stow_scan', description: '扫描本机插件/技能/工具', owner: '@fanyingnie/dsh-guizhi' },
]

const PLUGIN_ROWS = [
  { name: '@fanyingnie/dsh-guizhi', version: '0.1.0', source: 'patch' },
  { name: 'dsh-ops', version: '0.5.6', source: 'npm' },
  { name: 'dsh-better-sidebar', source: 'patch' },
]

const SKILL_ROWS = [
  { name: 'brainstorming', source: 'user' },
  { name: 'writing-plans', source: 'bundled' },
]

/** read x2, grep x1 inside the window; write outside it (so it is a *known* zero). */
const EVENT_ROWS = [
  { tool: 'read', at: daysBefore(1), sessionId: 'session-1' },
  { tool: 'read', at: daysBefore(2), sessionId: 'session-2' },
  { tool: 'grep', at: daysBefore(5), sessionId: 'session-1' },
  { tool: 'write', at: daysBefore(45), sessionId: 'session-3' },
]

/** Public format-1 catalog rows: one matches web-search, one is already installed. */
const CATALOG_ENTRIES = [
  { name: 'dsh-web-search', title: '联网搜索', description: '为 agent 提供联网搜索与网页抓取能力。' },
  { name: '@fanyingnie/dsh-guizhi', title: '联网搜索', description: '本机已安装，缺口分析不得再推荐。' },
]

/**
 * Fake HostAdapter with createHostAdapter shape: async list methods, a
 * warnings snapshot and an async tool/call event stream.
 * @param {{ events?: unknown[] | null, warnings?: string[] }} [options]
 */
function createFakeHost(options = {}) {
  const warningLog = Array.isArray(options.warnings) ? options.warnings.slice() : []
  const events = options.events === undefined ? EVENT_ROWS : options.events
  return {
    get warnings() {
      return warningLog.slice()
    },
    pushWarning(message) {
      warningLog.push(String(message))
    },
    async listTools() {
      return cloneJson(TOOL_ROWS)
    },
    async listPlugins() {
      return cloneJson(PLUGIN_ROWS)
    },
    async listSkills() {
      return cloneJson(SKILL_ROWS)
    },
    sessionEvents() {
      if (events === null) return null
      const rows = cloneJson(events)
      return (async function* iterate() {
        for (const row of rows) yield row
      })()
    },
  }
}

/**
 * Real store + injected fake host/catalog over one temp root; real route
 * handlers. Data root = <root>/guizhi and skills root = <root>/skills, exactly
 * like lib/index.js derives $DSH_HOME/skills from $DSH_HOME/guizhi.
 */
async function createHarness(prefix) {
  const root = await createHome(prefix)
  const home = join(root, 'guizhi')
  const skillsHome = join(root, 'skills')
  const store = createStore({ home })
  const host = createFakeHost()
  const deps = {
    host,
    store,
    home,
    skillsHome,
    now: () => new Date(NOW),
    catalog: { entries: CATALOG_ENTRIES, stale: false, error: null },
  }
  const byPath = new Map(createRoutes({ deps }).map((route) => [route.path, route.handler]))
  /** Call one real route handler. @param {string} path @param {unknown} [payload] */
  const call = async (path, payload) => {
    const handler = byPath.get(path)
    assert.equal(typeof handler, 'function', '缺少路由 ' + path)
    return handler(payload)
  }
  return { home, skillsHome, store, host, deps, call }
}

// ---------------------------------------------------------------------------
// Step 1: scan facts through the real summarizeUsage + scanFacts
// ---------------------------------------------------------------------------

test('scan：真实 summarizeUsage + scanFacts 合并同名多 owner、统计窗口内用量', async () => {
  const host = createFakeHost()
  const usage = await summarizeUsage({ events: host.sessionEvents(), now: NOW })
  assert.equal(usage.unknown, false)
  assert.deepEqual(usage.byTool.get('read'), { count: 2, lastUsedAt: daysBefore(1) })
  assert.deepEqual(usage.byTool.get('grep'), { count: 1, lastUsedAt: daysBefore(5) })
  assert.equal(usage.byTool.has('write'), false, '窗口外事件不计入')

  const scan = await scanFacts({ host, usage, now: NOW })
  assert.deepEqual(schemas.scan.validate(scan), { ok: true, errors: [] })
  assert.equal(scan.generatedAt, NOW_ISO)
  assert.equal(scan.plugins.length, 3)
  assert.equal(scan.skills.length, 2)

  const byName = new Map(scan.tools.map((tool) => [tool.name, tool]))
  assert.equal(byName.size, 4, '同名工具行合并为一个工具')
  const read = byName.get('read')
  assert.deepEqual(read.owners, ['@deepseek-ai/dsh-tool-fs', 'dsh-better-sidebar'], '保留全部来源、去重保序')
  assert.equal(read.description, 'Read a UTF-8 text file', '描述取第一条')
  assert.equal(read.used30d, 2)
  assert.equal(read.lastUsedAt, daysBefore(1))
  assert.equal(byName.get('grep').used30d, 1)
  assert.equal(byName.get('write').used30d, 0, '窗口外 = 已知 0，不是未知')
  assert.equal(byName.get('write').lastUsedAt, null)
  assert.equal(byName.get('stow_scan').used30d, 0)
  assert.equal(scan.totals.unusedTools, 2, '只有已知 0 次计入未用')
  assert.equal(scan.totals.plugins, 3)
  assert.equal(scan.totals.tools, 4)
  assert.equal(scan.totals.skills, 2)
})

test('scan：会话事件源不可用时用量未知（used30d null，不写成 0）', async () => {
  const host = createFakeHost({ events: null })
  const usage = await summarizeUsage({ events: host.sessionEvents(), now: NOW })
  assert.equal(usage.unknown, true)
  const scan = await scanFacts({ host, usage, now: NOW })
  assert.deepEqual(schemas.scan.validate(scan), { ok: true, errors: [] })
  for (const tool of scan.tools) assert.equal(tool.used30d, null)
  assert.equal(scan.totals.unusedTools, 0)
})

// ---------------------------------------------------------------------------
// Steps 2-9: the full panel chain over real handlers + real data root
// ---------------------------------------------------------------------------

test('e2e：scan → 场景 → 地图 → 缺口 → 包 → 预览 → 应用 → 回滚 全链路', async () => {
  const { home, skillsHome, store, call } = await createHarness('guizhi-e2e-')
  const stateFile = (name) => join(home, name + '.json')

  // --- 0) 空状态：四份文档都不存在（首次使用不是错误） -------------------
  const initial = await call(ROUTE_PATHS.state, {})
  assert.equal(initial.status, 200)
  assert.equal(initial.json.scan, null)
  assert.equal(initial.json.map, null)
  assert.equal(initial.json.proposals, null)
  assert.equal(initial.json.selections, null)
  assert.deepEqual(initial.json.warnings, [])
  assert.deepEqual(initial.json.advice, { items: [] }, '空状态没有建议')

  // --- 1) 无地图时 gaps 必须是 400 NO_MAP，且不写 proposals（R-7A） ------
  const noMap = await call(ROUTE_PATHS.gaps, {})
  assert.equal(noMap.status, 400)
  assert.equal(noMap.json.code, 'NO_MAP')
  assert.match(noMap.json.error, /工作流/)
  await assert.rejects(stat(stateFile('proposals')), { code: 'ENOENT' })
  assert.equal((await store.read('proposals')).value, null, 'NO_MAP 不得覆盖旧提案')

  // --- 2) scan 走真实路由：写 scan.json 并返回 D7 scan ------------------
  const scanResponse = await call(ROUTE_PATHS.scan, {})
  assert.equal(scanResponse.status, 200, JSON.stringify(scanResponse.json))
  const scan = scanResponse.json
  assert.deepEqual(schemas.scan.validate(scan), { ok: true, errors: [] })
  assert.equal(scan.generatedAt, NOW_ISO)
  assert.deepEqual(await readJson(stateFile('scan')), scan)
  const readTool = scan.tools.find((tool) => tool.name === 'read')
  assert.deepEqual(readTool.owners, ['@deepseek-ai/dsh-tool-fs', 'dsh-better-sidebar'])
  assert.equal(readTool.used30d, 2)
  assert.equal(scan.totals.unusedTools, 2)

  // --- 3) 场景选择：normalize 后写 selections ---------------------------
  const scenarioInput = { selected: ['dev', 'dev', 'content', 'nope', 7], custom: '给研发团队做内部小工具' }
  const scenariosResponse = await call(ROUTE_PATHS.scenarios, scenarioInput)
  assert.equal(scenariosResponse.status, 200)
  const selections = scenariosResponse.json
  assert.deepEqual(selections, normalizeScenarios(scenarioInput))
  assert.deepEqual(selections.selected, ['dev', 'content'])
  assert.deepEqual(await readJson(stateFile('selections')), selections)
  assert.deepEqual(schemas.selections.validate(selections), { ok: true, errors: [] })

  // --- 4) 地图（R-4A：stage 带可选 tools/skills；能力点带 evidence） -----
  const stages = [
    {
      id: 'understand',
      title: '理解需求',
      capabilities: [
        {
          id: 'read-code',
          title: '读代码',
          status: 'have',
          evidence: { source: 'scan', tools: ['read'], used30d: 2, lastUsedAt: daysBefore(1) },
        },
      ],
      tools: ['read', 'grep', 'read'],
      skills: ['brainstorming'],
    },
    {
      id: 'deliver',
      title: '交付',
      capabilities: [
        { id: 'web-search', title: '联网搜索', status: 'missing', evidence: { source: 'catalog' } },
        { id: 'notes', title: '笔记', status: 'redundant', evidence: { source: 'scan', tools: [] }, suggestion: '保留一个笔记技能即可。' },
        {
          id: 'write-doc',
          title: '写文档',
          status: 'have',
          evidence: { source: 'scan', tools: ['write'] },
        },
      ],
      tools: ['write', 'read'],
      skills: ['writing-plans', 'brainstorming'],
    },
  ]
  const map = createMap({ scenarios: selections.selected, custom: selections.custom, stages })
  assert.deepEqual(map.stages[0].tools, ['read', 'grep', 'read'], 'R-4A：stage.tools 原样保留')
  assert.equal(typeof map.stages[0].capabilities[0].evidence, 'object')
  const mapResponse = await call(ROUTE_PATHS.map, { map })
  assert.equal(mapResponse.status, 200)
  assert.deepEqual(mapResponse.json, { ok: true })
  assert.deepEqual(await readJson(stateFile('map')), map)
  const mapState = await call(ROUTE_PATHS.state, {})
  assert.equal(mapState.status, 200)
  const notesAdvice = mapState.json.advice.items.find((item) => item.capabilityId === 'notes')
  assert.ok(notesAdvice !== undefined, 'GET state 应返回冗余能力点的精简建议')
  assert.equal(notesAdvice.source, 'map')
  assert.equal(notesAdvice.text, '保留一个笔记技能即可。')
  assert.equal(mapState.json.map.stages[1].capabilities[1].suggestion, '保留一个笔记技能即可。')

  // --- 5) 查缺补漏：注入 catalog，真实 matchGaps 后写 proposals ----------
  const expectedGapItems = matchGaps({ scan, map, catalog: { entries: CATALOG_ENTRIES } })
  assert.equal(expectedGapItems.length, 1, '已安装的同名能力不得再推荐')
  const gapsResponse = await call(ROUTE_PATHS.gaps, {})
  assert.equal(gapsResponse.status, 200, JSON.stringify(gapsResponse.json))
  assert.deepEqual(gapsResponse.json.items, expectedGapItems)
  assert.equal(gapsResponse.json.error, null)
  assert.equal(gapsResponse.json.stale, false)
  const gapItem = gapsResponse.json.items[0]
  assert.equal(gapItem.kind, 'install')
  assert.equal(gapItem.id, 'gap-deliver-web-search-dsh-web-search')
  assert.deepEqual(gapItem.evidence, { source: 'catalog', refs: ['dsh-web-search'] })
  const storedProposals = await readJson(stateFile('proposals'))
  assert.deepEqual(storedProposals.items, expectedGapItems)
  assert.equal(storedProposals.generatedAt, NOW_ISO)
  assert.deepEqual(schemas.proposals.validate(storedProposals), { ok: true, errors: [] })

  // --- 6) 生成包提案：真实 /pack 写 proposals、不写 packs/ 文件（R-PACK）---
  const packTitle = '研发交付包'
  const stageIds = ['understand', 'deliver']
  const expectedPack = buildPack({ map, stageIds, title: packTitle })
  const packResponse = await call(ROUTE_PATHS.pack, { stageIds, title: packTitle })
  assert.equal(packResponse.status, 200, JSON.stringify(packResponse.json))
  assert.deepEqual(Object.keys(packResponse.json).sort(), ['pack', 'proposal'], 'R-PACK：/pack 返回 {pack,proposal}')
  const pack = packResponse.json.pack
  const packProposal = packResponse.json.proposal
  assert.deepEqual(packWithoutTimestamp(pack), packWithoutTimestamp(expectedPack))
  assert.match(pack.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(schemas.pack.validate(pack), { ok: true, errors: [] })
  assert.deepEqual(pack.tools, ['read', 'grep', 'write'], '跨阶段合并去重保序')
  assert.deepEqual(pack.skills, ['brainstorming', 'writing-plans'], '跨阶段合并去重保序')
  assert.equal(pack.version, 1)
  assert.deepEqual(pack.requirements, { appliesAt: 'new-session', ownSession: false })
  assert.deepEqual(packProposal, {
    id: pack.id,
    kind: 'pack',
    title: packTitle,
    effect: '导出装配清单 研发交付包（3 个工具 / 2 个技能）；应用时可选择安装工作流技能 stow-' + pack.id + '（默认不安装）',
    evidence: { source: 'map', refs: stageIds },
  })
  await assert.rejects(stat(join(home, 'packs')), { code: 'ENOENT' }, 'R-PACK：/pack 不得写 packs/ 文件')
  const storedPacks = await readJson(stateFile('packs'))
  assert.deepEqual(schemas.packs.validate(storedPacks), { ok: true, errors: [] })
  assert.deepEqual(storedPacks, { packs: [pack] }, 'F2/R-8A：/pack 生成时就把 pack 写进 store(packs)')
  const storedAfterPack = await readJson(stateFile('proposals'))
  assert.deepEqual(storedAfterPack.items, [...storedProposals.items, packProposal], '安装提案保留 + pack 提案追加')
  assert.equal(storedAfterPack.generatedAt, NOW_ISO)
  assert.deepEqual(schemas.proposals.validate(storedAfterPack), { ok: true, errors: [] })

  // --- 7) 预览：安装提案 + 真实 /pack 生成的 pack 提案都在预览里 ----------
  const previewAll = await call(ROUTE_PATHS.preview, {})
  assert.equal(previewAll.status, 200, JSON.stringify(previewAll.json))
  assert.deepEqual(previewAll.json.items.map((item) => item.id), [gapItem.id, pack.id])
  assert.match(previewAll.json.hash, /^[0-9a-f]{64}$/)
  const previewAgain = await call(ROUTE_PATHS.preview, {})
  assert.equal(previewAgain.json.hash, previewAll.json.hash, '同输入 hash 必须稳定')
  const previewFiltered = await call(ROUTE_PATHS.preview, { ids: [pack.id] })
  assert.equal(previewFiltered.status, 200)
  assert.deepEqual(previewFiltered.json.items.map((item) => item.id), [pack.id], 'ids 过滤生效')
  assert.notEqual(previewFiltered.json.hash, previewAll.json.hash)
  assert.equal(previewAll.json.items[0].title, gapItem.title)
  assert.equal(previewAll.json.items[0].effect, gapItem.effect)
  assert.equal(previewAll.json.items[1].title, packTitle)
  assert.match(previewAll.json.items[1].effect, /导出装配清单/)

  // Snapshot the pre-apply state (after /pack) for the final restore assertion.
  const preApply = await call(ROUTE_PATHS.state, {})
  assert.equal(preApply.status, 200)
  assert.deepEqual(preApply.json.proposals, storedAfterPack)

  // --- 8) 应用：apply 才落盘——快照 → 台账（含 existedBefore）→ 包文件 ---
  // F2/R-8A：apply 直接导出 /pack 时存储的 pack，不再用当前 map 重建。
  const expectedAppliedPack = pack
  const applyResponse = await call(ROUTE_PATHS.apply, { ids: [packProposal.id, gapItem.id], installSkill: true })
  assert.equal(applyResponse.status, 200, JSON.stringify(applyResponse.json))
  assert.deepEqual(applyResponse.json.applied, [packProposal.id], 'install 提案 v1 不应用')
  assert.equal(applyResponse.json.warnings.length, 1)
  assert.match(applyResponse.json.warnings[0], /v1 暂不安装/)
  assert.match(applyResponse.json.warnings[0], /联网搜索/)
  const snapshotId = applyResponse.json.snapshotId
  assert.match(snapshotId, /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/)

  const snapshots = await store.listSnapshots()
  const applySnapshot = snapshots.find((snapshot) => snapshot.id === snapshotId)
  assert.ok(applySnapshot !== undefined, 'apply 必须先创建快照')
  assert.equal(applySnapshot.tag, 'before-apply')
  const snapshotMeta = await readJson(join(home, 'snapshots', snapshotId, 'meta.json'))
  assert.deepEqual(snapshotMeta.files, ['map.json', 'packs.json', 'proposals.json', 'scan.json', 'selections.json'])

  const appliedPackPath = join(home, 'packs', expectedAppliedPack.id + '.json')
  const ledger = await readJson(join(home, 'snapshots', snapshotId, 'packs-created.json'))
  assert.deepEqual(ledger.entries, [{ path: appliedPackPath, existedBefore: false }], 'R-6A/F1：台账记路径与「应用前是否存在」')
  assert.deepEqual(await readdir(join(home, 'packs')), [expectedAppliedPack.id + '.json'], 'apply 后 packs/ 里只有本次导出的包（/pack 没写过文件）')
  const appliedPackDoc = await readJson(appliedPackPath)
  assert.deepEqual(appliedPackDoc, expectedAppliedPack, '落盘内容必须等于 /pack 时存储的 pack（R-8A）')
  assert.deepEqual(expectedAppliedPack.tools, ['read', 'grep', 'write'])
  assert.deepEqual(expectedAppliedPack.skills, ['brainstorming', 'writing-plans'])

  // S2: apply 同时把非空装配清单安装成工作流技能（SKILL.md）
  const skillName = 'stow-' + expectedAppliedPack.id
  const skillPath = join(skillsHome, skillName, 'SKILL.md')
  assert.deepEqual(applyResponse.json.skills, [{ name: skillName, path: skillPath }], 'S2：apply 响应必须带 skills')
  const skillMarkdown = await readFile(skillPath, 'utf8')
  assert.match(skillMarkdown, /^---\nname: "stow-/)
  assert.match(skillMarkdown, new RegExp(packTitle))
  assert.match(skillMarkdown, /## 验收清单/)
  assert.deepEqual(await readJson(join(home, 'snapshots', snapshotId, 'skills-created.json')), {
    entries: [{ name: skillName, path: skillPath, existedBefore: false }],
  })

  // Change a state document after apply so rollback restore is observable.
  const mutated = await call(ROUTE_PATHS.scenarios, { selected: ['daily'], custom: 'apply 之后的改动' })
  assert.equal(mutated.status, 200)
  assert.deepEqual((await call(ROUTE_PATHS.state, {})).json.selections, { selected: ['daily'], custom: 'apply 之后的改动' })

  // --- 9) 回滚：删包文件 + 恢复 apply 前状态；重复回滚幂等 --------------
  const rollbackResponse = await call(ROUTE_PATHS.rollback, { snapshotId })
  assert.equal(rollbackResponse.status, 200, JSON.stringify(rollbackResponse.json))
  assert.deepEqual(rollbackResponse.json, { restored: true })
  await assert.rejects(stat(appliedPackPath), { code: 'ENOENT' }, '台账记录的包文件必须被删除')
  assert.deepEqual(await readdir(join(home, 'packs')), [], '回滚后本次导出的包文件不残留')
  // S2: 回滚同时删除本次安装的技能文件与空目录
  await assert.rejects(stat(skillPath), { code: 'ENOENT' }, '回滚必须删除本次安装的技能')
  await assert.rejects(stat(join(skillsHome, skillName)), { code: 'ENOENT' })
  assert.deepEqual(await readJson(stateFile('packs')), storedPacks, 'rollback 恢复 apply 前的 packs 状态')

  const restoredState = await call(ROUTE_PATHS.state, {})
  assert.deepEqual(restoredState.json, preApply.json, 'scan/map/proposals/selections 必须恢复到 apply 前')
  assert.deepEqual(await readJson(stateFile('selections')), preApply.json.selections)

  const rollbackAgain = await call(ROUTE_PATHS.rollback, { snapshotId })
  assert.equal(rollbackAgain.status, 200, '重复回滚同一快照必须幂等')
  assert.deepEqual(rollbackAgain.json, { restored: true })
  await assert.rejects(stat(appliedPackPath), { code: 'ENOENT' })
  assert.deepEqual((await call(ROUTE_PATHS.state, {})).json, preApply.json)

  // --- 10) 最终状态：四份文档与快照前一致，无残留 .tmp ------------------
  for (const name of ['scan', 'map', 'proposals', 'selections']) {
    const stored = await readJson(stateFile(name))
    assert.deepEqual(stored, preApply.json[name], name + '.json 与快照前状态不一致')
  }
  assert.deepEqual(schemas.scan.validate(await readJson(stateFile('scan'))), { ok: true, errors: [] })
  assert.deepEqual(schemas.map.validate(await readJson(stateFile('map'))), { ok: true, errors: [] })
  assert.deepEqual(schemas.proposals.validate(await readJson(stateFile('proposals'))), { ok: true, errors: [] })
  assert.deepEqual(schemas.selections.validate(await readJson(stateFile('selections'))), { ok: true, errors: [] })

  const leftovers = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.tmp')) leftovers.push(full)
    }
  }
  await walk(home)
  assert.deepEqual(leftovers, [], '数据根里不得残留 .tmp 文件')
})

/** 同一组阶段但 understand 的工具声明不同：模拟「/pack 之后地图又变了」。 */
function mapWithUnderstandTools(understandTools) {
  return createMap({
    scenarios: ['dev'],
    stages: [
      { id: 'understand', title: '理解需求', capabilities: [], tools: understandTools },
      { id: 'deliver', title: '交付', capabilities: [], tools: ['edit'] },
    ],
  })
}

test('R-8A：/pack 后改地图，apply 仍导出生成时的 pack；preview items 形状不变', async () => {
  const { home, store, call } = await createHarness('guizhi-e2e-')
  const mapV1 = mapWithUnderstandTools(['read'])
  assert.equal((await call(ROUTE_PATHS.map, { map: mapV1 })).status, 200)
  const packResponse = await call(ROUTE_PATHS.pack, { stageIds: ['understand', 'deliver'], title: '研发交付包' })
  assert.equal(packResponse.status, 200, JSON.stringify(packResponse.json))
  const generated = packResponse.json.pack
  assert.deepEqual(generated.tools, ['read', 'edit'])
  const previewBefore = await call(ROUTE_PATHS.preview, { ids: [generated.id] })
  assert.equal(previewBefore.status, 200)
  assert.deepEqual(Object.keys(previewBefore.json.items[0]).sort(), ['effect', 'id', 'kind', 'title'])
  // 改地图：understand 多声明 write（若 apply 用新地图重建，tools 会变成 read/write/edit）
  assert.equal((await call(ROUTE_PATHS.map, { map: mapWithUnderstandTools(['read', 'write']) })).status, 200)
  const applyResponse = await call(ROUTE_PATHS.apply, { ids: [generated.id] })
  assert.equal(applyResponse.status, 200, JSON.stringify(applyResponse.json))
  const exported = JSON.parse(await readFile(join(home, 'packs', generated.id + '.json'), 'utf8'))
  assert.deepEqual(exported, generated, '必须导出 /pack 时存储的 pack（含 createdAt/tools），不是用新地图重建')
  assert.deepEqual(exported.tools, ['read', 'edit'])
  const previewAfter = await call(ROUTE_PATHS.preview, { ids: [generated.id] })
  assert.deepEqual(previewAfter.json, previewBefore.json, 'preview items 形状与内容不变（effect 来自生成时的 pack）')
  assert.deepEqual((await store.read('packs')).value.packs[0], generated)
})

test('R-6B：重新 /pack 同 id 包后二次 apply 覆盖，回滚第二次恢复第一版内容（端到端）', async () => {
  const { home, call } = await createHarness('guizhi-e2e-')
  const tab = { stageIds: ['understand', 'deliver'], title: '研发交付包' }
  assert.equal((await call(ROUTE_PATHS.map, { map: mapWithUnderstandTools(['read']) })).status, 200)
  const firstPack = (await call(ROUTE_PATHS.pack, tab)).json.pack
  assert.deepEqual(firstPack.tools, ['read', 'edit'])
  const firstApply = await call(ROUTE_PATHS.apply, { ids: [firstPack.id] })
  assert.equal(firstApply.status, 200, JSON.stringify(firstApply.json))
  const file = join(home, 'packs', firstPack.id + '.json')
  assert.deepEqual(await readJson(file), firstPack)
  // 改地图后重新生成：同 proposal/pack id，工具集不同（模拟契约 F1 的「apply v1 → 改 map → 再 apply」）
  assert.equal((await call(ROUTE_PATHS.map, { map: mapWithUnderstandTools(['read', 'write']) })).status, 200)
  const secondPack = (await call(ROUTE_PATHS.pack, tab)).json.pack
  assert.equal(secondPack.id, firstPack.id, '同 title+stageIds 的 pack id 必须相同')
  assert.deepEqual(secondPack.tools, ['read', 'write', 'edit'])
  const secondApply = await call(ROUTE_PATHS.apply, { ids: [firstPack.id] })
  assert.equal(secondApply.status, 200, JSON.stringify(secondApply.json))
  assert.deepEqual(await readJson(file), secondPack, '第二次 apply 覆盖旧包')
  // 回滚第二份快照：必须恢复第一版内容，不能删除快照前已存在的包
  const secondRollback = await call(ROUTE_PATHS.rollback, { snapshotId: secondApply.json.snapshotId })
  assert.equal(secondRollback.status, 200, JSON.stringify(secondRollback.json))
  assert.deepEqual(await readJson(file), firstPack, 'R-6B：回滚第二次 apply 恢复到第一版字节')
  // 第一份快照里该文件是新建的 → 回滚删除
  const firstRollback = await call(ROUTE_PATHS.rollback, { snapshotId: firstApply.json.snapshotId })
  assert.equal(firstRollback.status, 200, JSON.stringify(firstRollback.json))
  await assert.rejects(stat(file), { code: 'ENOENT' })
})

test('R-8A：提案存在但 store(packs) 缺失该包 → apply 400 PACK_NOT_FOUND，不落 packs/ 文件', async () => {
  const { home, call } = await createHarness('guizhi-e2e-')
  assert.equal((await call(ROUTE_PATHS.map, { map: mapWithUnderstandTools(['read']) })).status, 200)
  const packResponse = await call(ROUTE_PATHS.pack, { stageIds: ['understand'], title: '研发包' })
  assert.equal(packResponse.status, 200)
  const packId = packResponse.json.pack.id
  // 模拟旧数据/手工清理：提案还在，能力包存储没了
  await rm(join(home, 'packs.json'), { force: true })
  const response = await call(ROUTE_PATHS.apply, { ids: [packId] })
  assert.equal(response.status, 400, JSON.stringify(response.json))
  assert.equal(response.json.code, 'PACK_NOT_FOUND')
  await assert.rejects(stat(join(home, 'packs')), { code: 'ENOENT' })
})

test('S2：apply 安装工作流技能；覆盖旧 SKILL.md 后 rollback 恢复旧字节，重复回滚幂等（端到端）', async () => {
  const { home, skillsHome, call } = await createHarness('guizhi-e2e-')
  assert.equal((await call(ROUTE_PATHS.map, { map: mapWithUnderstandTools(['read']) })).status, 200)
  const pack = (await call(ROUTE_PATHS.pack, { stageIds: ['understand', 'deliver'], title: '技能包' })).json.pack
  const skillName = 'stow-' + pack.id
  const target = join(skillsHome, skillName, 'SKILL.md')
  await mkdir(join(skillsHome, skillName), { recursive: true })
  const oldBytes = Buffer.from('# 旧技能\n旧字节\n', 'utf8')
  await writeFile(target, oldBytes)
  const applied = await call(ROUTE_PATHS.apply, { ids: [pack.id], installSkill: true })
  assert.equal(applied.status, 200, JSON.stringify(applied.json))
  assert.deepEqual(applied.json.skills, [{ name: skillName, path: target }])
  const written = await readFile(target, 'utf8')
  assert.notEqual(written, oldBytes.toString('utf8'))
  assert.match(written, /技能包/)
  assert.match(written, /## 验收清单/)
  assert.deepEqual(await readJson(join(home, 'snapshots', applied.json.snapshotId, 'skills-created.json')), {
    entries: [{ name: skillName, path: target, existedBefore: true }],
  })
  assert.deepEqual(
    await readFile(join(home, 'snapshots', applied.json.snapshotId, 'skills-backup', skillName, 'SKILL.md')),
    oldBytes,
    '覆盖前旧字节必须有备份',
  )
  const rolled = await call(ROUTE_PATHS.rollback, { snapshotId: applied.json.snapshotId })
  assert.equal(rolled.status, 200, JSON.stringify(rolled.json))
  assert.deepEqual(await readFile(target), oldBytes, '回滚必须恢复旧技能字节')
  const again = await call(ROUTE_PATHS.rollback, { snapshotId: applied.json.snapshotId })
  assert.equal(again.status, 200)
  assert.deepEqual(await readFile(target), oldBytes, '重复回滚恢复同一份旧字节')
  // 第二次 apply → rollback：备份来自第二份快照，仍恢复旧字节
  const second = await call(ROUTE_PATHS.apply, { ids: [pack.id], installSkill: true })
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.notEqual(await readFile(target, 'utf8'), oldBytes.toString('utf8'))
  const secondRollback = await call(ROUTE_PATHS.rollback, { snapshotId: second.json.snapshotId })
  assert.equal(secondRollback.status, 200)
  assert.deepEqual(await readFile(target), oldBytes)
})

test('e2e：apply 默认只导出清单，installSkill=true 才安装技能；draft packId 生成父→子派单载荷', async () => {
  const { home, skillsHome, call } = await createHarness('guizhi-e2e-')
  assert.equal((await call(ROUTE_PATHS.map, { map: mapWithUnderstandTools(['read']) })).status, 200)
  const pack = (await call(ROUTE_PATHS.pack, { stageIds: ['understand', 'deliver'], title: '技能包' })).json.pack
  const skillName = 'stow-' + pack.id
  const skillPath = join(skillsHome, skillName, 'SKILL.md')

  // 缺省：deps 里有 skillsHome 也只导出装配清单，不安装技能、响应 skills 为空
  const defaultApply = await call(ROUTE_PATHS.apply, { ids: [pack.id] })
  assert.equal(defaultApply.status, 200, JSON.stringify(defaultApply.json))
  assert.deepEqual(defaultApply.json.skills, [])
  await assert.rejects(stat(skillPath), { code: 'ENOENT' })
  assert.equal((await stat(join(home, 'packs', pack.id + '.json'))).isFile(), true)

  // opt-in：安装技能到 $DSH_HOME/skills，并可由 rollback 删除
  const optedIn = await call(ROUTE_PATHS.apply, { ids: [pack.id], installSkill: true })
  assert.equal(optedIn.status, 200, JSON.stringify(optedIn.json))
  assert.deepEqual(optedIn.json.skills, [{ name: skillName, path: skillPath }])
  assert.equal((await stat(skillPath)).isFile(), true)
  const rollback = await call(ROUTE_PATHS.rollback, { snapshotId: optedIn.json.snapshotId })
  assert.equal(rollback.status, 200, JSON.stringify(rollback.json))
  await assert.rejects(stat(skillPath), { code: 'ENOENT' })

  // packId 派单草稿：结构化载荷 + 软约束声明，不要求先扫描
  const draft = await call(ROUTE_PATHS.draft, { kind: 'dispatch', packId: pack.id })
  assert.equal(draft.status, 200, JSON.stringify(draft.json))
  for (const phrase of ['技能包', '阶段与能力点', '执行步骤', '验收清单', '只使用上述工具/技能；这是软约束，工具面未被硬限制。']) {
    assert.ok(draft.json.text.includes(phrase), '草稿缺少「' + phrase + '」：\n' + draft.json.text)
  }
  assert.doesNotMatch(draft.json.text, /这个活只需要/)
})

test('e2e：pack 受限 worker 派发走真实 store 落盘（plan→create→prompt）与软派单降级', async () => {
  const { home, host, call } = await createHarness('guizhi-e2e-')
  assert.equal((await call(ROUTE_PATHS.map, { map: mapWithUnderstandTools(['read']) })).status, 200)
  const pack = (await call(ROUTE_PATHS.pack, { stageIds: ['understand'], title: '受限包' })).json.pack
  const prepared = []
  const forgotten = []
  let createdWith = null
  let promptText = ''
  host.dispatchSupport = () => ({ available: true })
  host.prepareWorkerToolFace = (sessionId, allowedTools) => {
    prepared.push({ sessionId, allowedTools: allowedTools.slice() })
    return true
  }
  host.forgetWorkerToolFace = (sessionId) => forgotten.push(sessionId)
  host.createDispatchSession = async (request) => {
    createdWith = request
    return request.sessionId
  }
  host.promptDispatchSession = async (request) => {
    promptText = request.text
  }
  host.readDispatchEvents = async () => ({ status: 'events', events: [] })
  const response = await call(ROUTE_PATHS.dispatch, { kind: 'pack', packId: pack.id })
  assert.equal(response.status, 200, JSON.stringify(response.json))
  assert.equal(response.json.toolFaceApplied, true)
  assert.equal(prepared.length, 1)
  assert.match(prepared[0].sessionId, /^session-/)
  assert.deepEqual(prepared[0].allowedTools, ['read'])
  assert.deepEqual(createdWith, { sessionId: prepared[0].sessionId })
  assert.ok(promptText.includes('只使用以下工具'), promptText)
  assert.ok(promptText.includes('受限包'), promptText)
  assert.deepEqual(forgotten, [])
  // 真实 store 文件：dispatch.json kind=pack，GET state 读回并派生 running
  const persisted = await readJson(join(home, 'dispatch.json'))
  assert.equal(persisted.kind, 'pack')
  assert.equal(persisted.sessionId, prepared[0].sessionId)
  const state = await call(ROUTE_PATHS.state, {})
  assert.equal(state.status, 200)
  assert.equal(state.json.dispatch.kind, 'pack')
  assert.equal(state.json.dispatch.state, 'running')
})
