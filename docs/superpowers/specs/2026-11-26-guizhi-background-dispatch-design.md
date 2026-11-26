# 归置 · 后台派单（Agent 后台拆解地图）设计

- 日期：2026-11-26
- 状态：草案，待用户确认（确认后才进入实现计划）
- 触发：用户要求「面板一键让本地 agent 去做，不用单开会话」；已选定方案 B（后台会话执行，不切主界面、不打断当前对话）

## 意图与原因

归置面板的地图页目前只有空状态文案：「v1 的拆解由会话里的 agent 完成」。用户必须自己切到某个会话，重新描述一遍需求，agent 才会调用 stow_map_save。
目标是把这一步变成面板里的一次点击：由插件在后台创建一个专用会话，把「按已保存的场景选择拆解 D7 工作流地图」的任务发进去，agent 在后台执行；面板显示执行中/完成/失败，完成后 3 秒轮询自然刷新地图。

## 目标 / 非目标 / 反目标

- 目标：地图页空状态提供一个「让 Agent 后台拆解」按钮；一键派单；不切换主视图、不新开可见会话、不打断当前对话；面板能显示进行中/完成/失败原因，并可重试；agent 产出写入 map 后地图页自动出现。
- 非目标：不做方案 A（把 prompt 直接塞进当前对话）；不自动跳转到后台会话；不新增工具面；不修改 profile / 不安装插件；不调用模型做面板渲染。
- 反目标：按钮静默失败；重复点击重复建会话/重复派单；把 agent 超时或失败显示成成功；在场景未保存时让 agent 猜场景；把后台会话当作用户当前会话。

## 约束

- 只使用 DSH 0.2.2-rc.5 已存在的宿主服务：`sessionController`（create/prompt）、`sessionQuery`（readSession）；不修改宿主、不改 profile。
- 架构不变量保持：只有 `lib/index.js` import `@deepseek-ai/dsh-tools`；宿主服务访问收敛在 `lib/host.js` 的 HostAdapter（defensive，服务缺失返回 null 而不是抛）。
- 状态写入仍走 `lib/store.js`（临时文件 + rename 原子写，单文件 < 1MB）；数据根 `$DSH_HOME/guizhi`。
- 面板路由维持 document-relative `api/guizhi/...`，host 路由 `/api/guizhi/...`，沿用现有 body 上限与 loopback 围栏。
- 一次只允许一个后台派单（single-flight），避免同一地图被两个 agent 并发覆盖。

## 备选方案

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A 当前会话 | 客户端取当前主视图会话，`conversation.send(prompt)` | 过程可见、上下文连续；但会往用户当前对话追加用户消息，用户已明确不选 |
| **B 后台会话（选定）** | host 侧用 `sessionController` 创建/复用一个专用后台会话，`prompt` 投递任务；面板轮询状态 | 不打扰当前对话；代价是后台 agent 无当前对话上下文，prompt 必须自带完整任务状态 |
| C 官方同款 | `uiWorkspace.startSession(..., {prompt})` 开空白会话预填草稿 | 最稳但需要用户回车、且仍是新会话 |

## 设计

### 1. 后台会话

- 首次派单时由 host 调 `sessionController.create({ workspaceId? })` 创建会话；`workspaceId` 可选，由面板从当前会话所在工作区带入，服务端用 `workspaceRegistry` 校验，无效/缺省则不指定（未分组）。
- 会话 id 写入新状态文档 `dispatch.json`，之后每次派单复用同一会话（上下文累积：上次扫描结果、上次地图结构都还在）。
- 若记录的会话不再存在（被删/归档/格式不兼容），重新创建并覆盖记录。
- 会话标题交给 agent 首轮自动生成，不额外改名。

### 2. 派单流程（POST /api/guizhi/dispatch）

请求：`{ kind: 'map', workspaceId?: string }`（v1 只接受 kind=map）。
处理：读 `selections` 状态 → 无有效场景则 400；`dispatch` 里有 running 则 409；否则 ensure 会话 → 组装 prompt → `sessionController.prompt({ sessionId, requestId: randomUUID(), content: [{type:'text', text}], mode: 'queue' })` → 写入 dispatch 记录（running, requestId, startedAt, kind, sessionId）→ 返回 200 `{ ok: true, dispatch }`。
失败：会话创建/投递失败写入 `state:'failed'` 并返回 502 + 可读 message；服务缺失（宿主不提供 sessionController）返回 503。

### 3. Prompt 约定

prompt 由服务端构造，包含：角色与任务（按 D7 map 结构拆解 stages/capabilities，调 `stow_map_save` 保存）；当前 scan 摘要（插件/工具/技能数、近 30 天用量是否未知）；已保存的场景选择；证据要求（能力点要有真实插件/工具/技能引用）；边界（只调用 stow_* 与本机只读信息，不改 profile/插件/文件系统，不安装任何东西）；结束条件（保存成功或明确失败，最后一句汇报）。

### 4. 状态推导（GET /api/guizhi/state 新增 dispatch 字段）

- 以会话事件日志为准：`sessionQuery.readSession(sessionId)`，找到 `user/message` 且 `source.rpcId === requestId` 的标记；其后出现 `turn/end` 即 `done`；标记后无 `turn/end` 即 `running`。
- 超过 15 分钟仍未结束 → `timeout`；会话不存在/读取失败 → `lost`；投递失败 → `failed`。
- `dispatch` 字段返回 `{ state, kind, sessionId, startedAt, finishedAt?, error? }`；state 响应仍然 200，面板据此渲染。
- 不改面板轮询频率（仍 3s）；state 处理器读取会话日志失败时只给 dispatch 降级信息，不让整个 state 500。

### 5. 面板（client.js）

- 地图页空状态增加主按钮「让 Agent 后台拆解」；有 dispatch running 时按钮禁用并显示「后台执行中…（开始于 HH:MM）」；done/failed/timeout 显示一行结果与「重试」。
- 无已保存场景时按钮禁用，提示「先在「场景」页选择并保存」。
- 提供可选「查看后台会话」按钮，点击才 `ctx.uiWorkspace.openSession(sessionId)`，绝不自动切换。
- 复用现有「操作结果」区域展示派单结果；不新增全局 toast。

## 实现涉及文件（预估）

- 新增 `lib/dispatch.js`：prompt 构造、状态归约、single-flight 判定（纯函数为主，便于单测）。
- `lib/routes.js`：ROUTE_PATHS 增加 `dispatch`、state 增加 dispatch 字段、POST handler 与 guarded 接线。
- `lib/host.js`：HostAdapter 增加 `createDispatchSession / promptSession / readSessionEvents`（服务缺失返回 null）。
- `lib/store.js`：STATE_NAMES 增加 `dispatch`。
- `lib/index.js`：routes 的 deps 接线（不改工具面）。
- `client.js`：地图页按钮、状态行、查看会话。
- `test/routes.test.js`、`test/dispatch.test.js`（新增）、`test/store.test.js`、`test/client-sync.test.js`；`docs/DEMO.md` 手动验证步骤。

## 验证与证据计划（按 dsh-plugin-guide 的规则如实记录）

- 单元测试：dispatch 状态归约、prompt 内容、single-flight、无场景 400、会话缺失重建、服务缺失 503、state 暴露 dispatch、store 白名单。
- 隔离 profile 真机：临时 DSH_HOME + base/web-app/guizhi 启动，验证按钮出现、POST 派单返回 accepted、专用会话被创建、prompt 被 accepted；**LLM 回合完成属于 not-run**（隔离环境无模型凭据），除非用户在桌面 profile 实测。
- 桌面 profile：需要用户重启一次后手动点一次「让 Agent 后台拆解」，检查地图生成 + 面板状态；结果记录到 host-notes 8.2（runtime/not-run 如实标注）。
- 不声称「已认证」「生产可用」等；BOOST 层面只做 effect/inject/降级的手动自查。

## 留给 builder 的开放项（不改变已定方案）

- `workspaceId` 从客户端哪个服务取最稳（`uiWorkspace` 主引用会话所属工作区 vs sessions 摘要），实现时以真机可用为准，取不到就不传。
- 专用会话的清扫策略（是否在多次失败后自动归档重建）先不做，记录在 dispatch.json 即可。
- 失败重试是重新 prompt 一次（同一会话），不重放旧 requestId。

## 交付门禁

本设计的实现（写产品代码、改 client.js、跑真机）在用户明确确认本文件后才开始；确认后按 writing-plans 产出实现计划。
