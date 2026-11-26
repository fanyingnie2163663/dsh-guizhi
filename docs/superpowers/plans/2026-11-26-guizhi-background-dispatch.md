# 归置后台 Agent 派单实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面板一键让 DSH 后台专用会话里的 agent 拆解 D7 工作流地图（调用 stow_map_save），不切换主界面、不打断当前对话。

**Architecture:** 宿主侧 `lib/dispatch.js` 负责 prompt 与状态归约（纯函数）；`lib/host.js` 的 HostAdapter 新增三个 `sessionController`/`sessionQuery` 转发方法（服务缺失降级）；`lib/routes.js` 新增 `POST /api/guizhi/dispatch` 并在 `GET /api/guizhi/state` 附带 `dispatch` 状态；`client.js` 地图页加按钮与状态行。

**Tech Stack:** Node >=24.9 ESM（无构建）、node:test、DSH 0.2.2-rc.5 宿主服务 `sessionController`/`sessionQuery`、原生浏览器 client.js（React.createElement + window.__ModuleLoader__）。

**Spec:** `docs/superpowers/specs/2026-11-26-guizhi-background-dispatch-design.md`

## Global Constraints

- 只有 `lib/index.js` 可以 import `@deepseek-ai/dsh-tools`；其余模块不得引入任何 `@deepseek-ai/*`。
- 状态写入只走 `lib/store.js`（临时文件 + rename 原子写，单文件 < 1MB，允许文档名见 STATE_NAMES）。
- 面板请求必须 document-relative（`api/guizhi/...`）；host 路由 `/api/guizhi/...`，沿用现有 body 上限与 loopback 围栏（复用 `guarded`）。
- 宿主服务访问只在 `lib/host.js` 收敛：缺失/抛错不得让 profile 加载或 state 轮询崩掉。
- 一切 UI 文案用中文；不改 profile、不安装插件、不调用模型做面板渲染。
- 测试命令：`node --test test/*.test.js`；语法检查：`node --check client.js`、`node --check lib/*.js`。

## Review Focus

1. 用户连点两次「后台拆解」：第二次必须 409 且不创建第二个会话、不重复投递。
2. 宿主缺少 `sessionController`（如精简 profile）：POST 返回 503 可读错误，面板按钮禁用并给出原因，不能 500。
3. 场景未保存就派单：必须 400 可读提示，且不创建会话、不投递 prompt。
4. agent 超时或专用会话被删除：状态从 running 变为 timeout/lost，面板可重试，不会永远显示执行中。
5. GET state 中会话日志读取失败：接口仍 200，`dispatch` 字段降级（state=unknown/null），不拖垮整个面板轮询。

---

### Task 1: dispatch 纯逻辑模块

**Files:**
- Create: `lib/dispatch.js`
- Create: `test/dispatch.test.js`

**Interfaces:**
- Produces: `DISPATCH_KIND_MAP = 'map'`；`DISPATCH_TIMEOUT_MS = 15 * 60 * 1000`；`buildMapPrompt({ scan, selections }) => string`；`createDispatchRecord({ kind, sessionId, requestId, startedAt }) => { kind, sessionId, requestId, startedAt, state: 'running' }`；`deriveDispatchState(record, events, now) => { state, finishedAt?, error? }`；`describeDispatch(record, derived) => { state, kind, sessionId, startedAt, finishedAt?, error? }`。
- `events` 为 `Array<{ seq, time, type, data }> | null`；`now` 为毫秒时间戳。

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dispatch.test.js` — Expected: FAIL（`../lib/dispatch.js` 不存在）。

- [ ] **Step 3: Implement `lib/dispatch.js`**

按上面签名实现。prompt 用中文多行文本，至少包含：任务（按 D7 `{scenarios, stages[capabilities]}` 拆解，调 `stow_map_save` 保存）、扫描摘要（totals 数字；缺失写「未知」）、场景标题列表（`selected` 用 `BUILTIN_SCENARIOS` 由 `lib/scenarios.js` 映射，未知 id 原样列出）、约束（只调用 stow_*、只读本机信息、不改 profile、不安装、不写业务文件）、结束要求（保存成功后一句话汇报）。`deriveDispatchState` 先判 failed，再判 events===null（lost），再找 marker（`type==='user/message' && data.source.rpcId===requestId`），marker 之后出现 `turn/end` 为 done，否则超时判 timeout，否则 running。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/dispatch.test.js` — Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/dispatch.js test/dispatch.test.js
git commit -m "feat: add dispatch prompt and state reducer"
```

### Task 2: store 增加 dispatch 状态文档

**Files:**
- Modify: `lib/store.js`（`STATE_NAMES` 增加 `'dispatch'`，注释同步）
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: 无；Produces: `store.read('dispatch')` / `write('dispatch', value)` / 快照包含 `dispatch.json`。

- [ ] **Step 1: Write the failing test**

在 `test/store.test.js` 加：`test('dispatch 是合法状态文档且快照会复制它', ...)`：`write('dispatch', { state: 'running' })` 后 `read('dispatch').value.state === 'running'`；`snapshot('t')` 的 `files` 包含 `dispatch.json`；`read('nope')` 仍拒绝。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js` — Expected: FAIL（未知状态名被拒）。

- [ ] **Step 3: Implement**

`STATE_NAMES = Object.freeze(['scan', 'map', 'proposals', 'sources', 'selections', 'packs', 'dispatch'])`，文件头布局注释加一行 `<home>/dispatch.json`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/store.test.js` — Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat: persist dispatch state document"
```

### Task 3: HostAdapter 转发后台会话能力

**Files:**
- Modify: `lib/host.js`（HostAdapter typedef + `createHostAdapter` 返回值）
- Modify: `lib/attribution.js`（`withAttribution` 转发新方法）
- Test: `test/host.test.js`

**Interfaces:**
- Produces（HostAdapter 新方法）：`dispatchSupport() => { available: boolean, reason?: string }`；`createDispatchSession() => Promise<string>`（失败抛 Error）；`promptDispatchSession({ sessionId, requestId, text }) => Promise<void>`；`readDispatchEvents(sessionId) => Promise<Array|null>`（读不到返回 null + warning，不抛）。

- [ ] **Step 1: Write the failing test**

在 `test/host.test.js` 用 fake ctx（`{ get(name){...} }`）加：无服务时 `dispatchSupport().available === false`；有 fake `sessionController.create`/`prompt` 与 `sessionQuery.readSession` 时 available 为 true；`createDispatchSession()` 返回 create 的 `sessionId` 且调用 `create({})`；`promptDispatchSession` 用 `{ sessionId, requestId, content:[{type:'text',text}], mode:'queue' }` 调 prompt；`readDispatchEvents` 返回 `readSession().events`，readSession 抛错时返回 null 且 warnings 含 dispatch 前缀。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/host.test.js` — Expected: FAIL。

- [ ] **Step 3: Implement**

在 adapter 内用现有 `tryGet`/`warn`：`dispatchSupport` 检查 `sessionController`（create+prompt 为函数）与 `sessionQuery`（readSession 为函数），缺失时 warn 一次并返回 `{ available: false, reason }`；三个方法在服务缺失时抛可读 Error（`后台派单需要的 sessionController 服务不可用`），其余异常原样向上抛；`readDispatchEvents` 捕获异常 warn 并返回 null。在 `lib/attribution.js` 的返回对象里用现有 `delegate('name')` 转发这四个方法。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/host.test.js` — Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/host.js lib/attribution.js test/host.test.js
git commit -m "feat: expose dispatch session capability on the host adapter"
```

### Task 4: 派单路由与 state 状态字段

**Files:**
- Modify: `lib/routes.js`（ROUTE_PATHS.dispatch、POST handler、runState 附带 dispatch）
- Test: `test/routes.test.js`

**Interfaces:**
- Consumes: Task 1 的 dispatch 模块、Task 3 的 adapter 方法、`readStateDocument(deps,'selections'|'scan'|'dispatch')`、`writeStateDocument(deps,name,value)`。
- Produces: `ROUTE_PATHS.dispatch = '/api/guizhi/dispatch'`；`POST` 响应 `{ ok: true, dispatch: { state, kind, sessionId, startedAt } }`；`GET state` 响应新增 `dispatch`（无记录为 null）。错误：400 参数/无场景、409 正在执行、503 宿主不支持、502 创建会话或投递失败。

- [ ] **Step 1: Write the failing test**

在 `test/routes.test.js` 扩展 fake host：`dispatchSupport: () => ({ available: true })`、`createDispatchSession: async () => 's1'`、`promptDispatchSession: async (req) => { calls.push(req) }`、`readDispatchEvents: async () => events`；加测试：
1) kind 缺失 → 400；2) `selected:[]` → 400 且 `calls.length===0`；3) support=false → 503；4) 成功 → status 200 且 `calls[0]` 的 sessionId/requestId/content 文本含 `stow_map_save`；5) store 里已有 running 记录 + 无 turn/end → 409；6) prompt 抛错 → 502 且 dispatch 状态写为 failed；7) `GET state` 带 running 记录时 `json.dispatch.state==='running'`；fake events 出现标记 user/message + turn/end 时 `json.dispatch.state==='done'`；8) readDispatchEvents 抛错时 state 仍 200 且 `json.dispatch.state==='unknown'`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/routes.test.js` — Expected: FAIL。

- [ ] **Step 3: Implement `runDispatch` + `runState` 修改**

`runDispatch(deps,payload)`：`requireBody`；`body.kind !== 'map'` → `badRequest('kind 必填且 v1 只支持 kind="map"')`；读 selections，`selected` 非空字符串数组否则 `badRequest('先在「场景」页选择并保存场景，再派单拆解地图')`；读 dispatch 记录并 `deriveDispatchState`，running → 新 helper `conflict(message)`（status 409）；`deps.host.dispatchSupport()` 不可用 → `unavailable(message)`（status 503）；读 scan；`buildMapPrompt`；若记录无 sessionId 或 derived.state==='lost' 则 `await deps.host.createDispatchSession()`；`requestId = randomUUID()`；`createDispatchRecord` → `await deps.host.promptDispatchSession(...)` → `writeStateDocument(deps,'dispatch',record)` → `ok({ ok: true, dispatch: describeDispatch(record, { state: 'running' }) })`；catch 时写 `{...record, state:'failed', error: describeError(error)}` 后 `dispatchFailed(...)`（status 502）。`runState` 末尾：读 dispatch 记录，无记录 `dispatch:null`；有记录且 support 可用时 `events = await deps.host.readDispatchEvents(record.sessionId).catch(()=>null)`，`describeDispatch`；任何异常 → `{ state:'unknown' }` 且不抛。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/routes.test.js` — Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/routes.js test/routes.test.js
git commit -m "feat: add background dispatch route and state field"
```

### Task 5: 面板按钮与状态显示

**Files:**
- Modify: `client.js`（地图页空状态、状态行、查看会话）
- Test: `test/client-sync.test.js`

**Interfaces:**
- Consumes: `POST api/guizhi/dispatch`（body `{ kind: 'map' }`）、`state.dispatch`、`apiRequest(path,{method,body})`、现有 `action`/`resultCard` 机制。
- Produces: 空状态按钮「让 Agent 后台拆解」；状态行文案「后台执行中… / 已完成 / 失败：… / 超时 / 会话已丢失」；可选「查看后台会话」按钮（点击才 `ctx.uiWorkspace.openSession(sessionId)`）。

- [ ] **Step 1: Write the failing static test**

`test/client-sync.test.js` 加：client 源码包含 `'让 Agent 后台拆解'`、`'api/guizhi/dispatch'` 可由 `API_BASE + 'dispatch'` 推得（断言包含 `'dispatch'` 与按钮文案）、`data.dispatch`、`后台执行中`；断言不含自动跳转（不出现 `uiWorkspace.openSession` 在非点击处理路径——以 `openDispatchSession` 命名并只被 onClick 引用为准）。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/client-sync.test.js` — Expected: FAIL。

- [ ] **Step 3: Implement client changes**

在 `renderMap()` 的 `stages.length === 0` 空状态里加：说明改为「点下面按钮让后台 agent 拆解并保存；不需要新开会话。」；按钮 disabled 条件 = `!hasSelections || dispatchState===`running` || dispatch?.available===false`，title 说明禁用原因；点击调 `apiRequest('dispatch', {method:'POST', body:{kind:'map'}})`，成功把返回 `dispatch` 合并进 data 并 `setResult({kind:'dispatch', ...})`，失败用现有错误渲染。地图页顶部（或 actionbar 上方）渲染 `renderDispatchStatus(data.dispatch)`：running→「后台执行中…（开始于 HH:MM）」；done→「已完成（HH:MM）」；failed/timeout/lost→对应文案 + error；并渲染「查看后台会话」按钮（有 sessionId 时），onClick 内 `try { const ui = ctx.get && ctx.get('uiWorkspace', false); if (ui && ui.openSession) ui.openSession(id) } catch (e) { console.warn(...) }`。

- [ ] **Step 4: Run checks**

Run: `node --test test/client-sync.test.js && node --check client.js` — Expected: PASS / 无输出。

- [ ] **Step 5: Commit**

```bash
git add client.js test/client-sync.test.js
git commit -m "feat: one-click background agent dispatch on the map panel"
```

### Task 6: 文档与真机验证

**Files:**
- Modify: `docs/DEMO.md`（§4.2 补后台派单步骤）
- Modify: `docs/host-notes.md`（新增 §8.2 真机记录，如实标 runtime/not-run）

- [ ] **Step 1: 更新文档**：DEMO 写明「点『让 Agent 后台拆解』→ 面板显示执行中 → agent 完成后地图出现；查看后台会话是可选操作」；host-notes §8.2 记录 `sessionController.create/prompt` 契约证据（文件:行号）与本次隔离/桌面验证结果。
- [ ] **Step 2: 全量验证**：`node --test test/*.test.js`（期望全绿）、`node --check client.js`、`node --check lib/dispatch.js lib/routes.js lib/host.js lib/store.js`。
- [ ] **Step 3: 隔离 profile 真机**：临时 DSH_HOME + base/web-app/guizhi 启动 web GUI，经 HTTP `POST scan`→`POST scenarios`（selected:['dev']）→`POST dispatch`，检查返回 accepted、`$DSH_HOME/guizhi/dispatch.json` 有 running 记录、`GET state` 的 dispatch.state 为 running；LLM 回合完成在隔离环境标 not-run。
- [ ] **Step 4: 记录并提交**：把实际命令、时间、输出摘要写进 host-notes §8.2；`git add docs/DEMO.md docs/host-notes.md && git commit -m "docs: background dispatch verification notes"`。

## Self-Review（计划自检）

- 覆盖设计 §1–§5：后台会话（Task 3/4）、派单流程（Task 4）、prompt（Task 1）、状态推导（Task 1/4）、面板（Task 5）、降级（Task 3/4）、文档（Task 6）。
- Review Focus 5 条各有测试归属：1→Task 4.5、2→Task 4.3、3→Task 4.2、4→Task 1/4.7、5→Task 4.8。
- 类型一致：`dispatchSupport/createDispatchSession/promptDispatchSession/readDispatchEvents` 在 Task 3 定义，Task 4 消费同名；`describeDispatch/deriveDispatchState` 在 Task 1 定义并复用。
