# Host 能力探测记录（Task 0 spike）

- 日期：2026-11-26
- 宿主：DeepSeek Harness 0.2.2-rc.5（本机 desktop profile）
- 探测方式：只读官方宿主源码 + 已装插件样例 + 契约核对（按裁决 D5：**不修改真实 profile、不重启 DSH**）
- 证据根（官方 app.asar 按 sha256 校验提取的源码）：`C:/Users/Administrator/AppData/Local/Temp/guizhi-asar/dsh-src/`
  - 下文 `dsh-*/` 均相对该根；`dsh/lib/*` 是宿主 app 启动层。
- 已装插件参考：`~/.dsh/profiles/desktop/node_modules/`（`@linxin666/dsh-client-ui-skill-explorer`、`dsh-better-sidebar`、`dsh-whale-widget`、`dshmarket`）
- 骨架参考（已验证在本机 DSH 0.2.2-rc.5 运行）：`C:/Users/Administrator/Desktop/未命名项目/dsh-whalebuddy/`

## 结论摘要

| # | 能力 | 状态 | 依据（宿主契约） | 本插件落点 |
|---|---|---|---|---|
| ① | 工具枚举 | **可用** | `tools` 服务 + `tools.view(scope)` | `lib/host.js` `listTools()` |
| ② | 插件清单 | **可用**（profile 文件为主，`pluginInventory` 兜底） | `profileContext` 服务 + profile `package.json` / `cordis.patch.yml` | `lib/host.js` `listPlugins()` |
| ③ | 技能来源 | **可用** | `skills` 服务 + `skills.list(options)` | `lib/host.js` `listSkills()` |
| ④ | 会话事件 | **可用**（`sessionQuery` + `readSession`；`listEvents` 不能给工具名） | `sessionQuery` 服务 | `lib/host.js` `sessionEvents()` |
| ⑤ | client 槽位 | **可用**（`sidebar.panellist` + `main`） | `slots` 服务 + `window.__ModuleLoader__` | `client.js` |
| ⑤b | 往输入框塞草稿 | **不可用**（未发现公开 API） | 提取源码/已装插件均无此 API | v1 用剪贴板兜底 |
| ⑥ | 注册 HTTP 路由 | **可用**（Task 0 不接线） | `webServer` 服务 + `webServer.register(route)` | **Task 0 不注册 HTTP 路由**；Task 7 以 `/api/guizhi` 前缀实现并有测试 |
| — | profile 路径 | **可用** | `profileContext` 服务 | `profilePath()` |
| — | DSH 版本 | **部分可用**（无运行时服务，靠探测） | CLI 启动层 `getDshRuntimeVersion()` | `dshVersion()`，可能 `unknown` |

## ① 工具枚举 API

**可用**。

- 服务定义：`ToolsService` — `dsh-tools/lib/index.js:404`；服务名 `tools` — `dsh-tools/lib/index.js:417`（`super(ctx, "tools")`）。
- 注册：`register(definition, options)` — `dsh-tools/lib/index.js:433`；`defineTool` 校验/装配 — `dsh-tools/lib/index.js:310-359`。
- 枚举：`view(scope)` — `dsh-tools/lib/index.js:477`；返回 `{ visible, registrations, knownNames, restrictableNames }` — `dsh-tools/lib/index.js:502-507`。`visible` 是 `Map<toolName, definition>`（:493/:499 `visible.set(name, registration.definition)`）。
- definition 的模型面字段只有 `name/description/parameters/deferLoading` — `projectToolSchema` `dsh-tools/lib/index.js:366-381`。

**owner（工具归属）不可用**：`view()` 只给 definition，没有注册者/插件来源字段（D8）。替代方案（后续 Task 2 做）：静态归因——读 profile 里各插件的 manifest / 源码声明的工具名，或复用 WhaleBuddy 的 knownToolNames/工具面快照思路；本任务 `listTools()` 只返回 `{name, description}`，`owner` 留空。

注意：`view(undefined)` 是全局视图；按 agent 的可见性需要 agent scope（Task 0 不做按 agent 统计）。

## ② 插件清单来源

**可用**：profile 文件为主来源，`pluginInventory` 服务为兜底。

- `profileContext` 服务：宿主在 profile boot 时 `provide` — `dsh/lib/profile-boot-QhDEDXsF.js:301-312` 构造 `{ name, dir, patchPath, installAnchor, startedBundles, cwd, home, overlays, ... }`，`:315` `hostCtx.provide("profileContext", profileContext)`。
  - 本插件 `profilePath()` 优先读 `ctx.get('profileContext').dir`；兜底 env `DSH_PROFILE`/argv `--profile` + `$DSH_HOME/profiles/<name>`。
- profile 文件结构（本机 desktop 实例只读核对）：
  - `$DSH_HOME/profiles/<name>/package.json`：`dependencies`（npm 安装面）+ `dsh.profile.bundles`（bundle 层顺序）。
  - `$DSH_HOME/profiles/<name>/cordis.patch.yml`：顶层数组的 patch 行；插件行形如 `- insert:\n    - id: x\n      name: '@scope/pkg'` 或 `- id: x\n  name: pkg`。
- `pluginInventory` 服务兜底：`dsh-host-plugin-inventory/lib/index.js:97`（`super(ctx, "pluginInventory")`）、`:112`（`async list()`）、`:118-145`（`readPluginInventory(ctx)`：`ctx.loader.entries()` + `pluginPackages.metaOf`，条目字段 `entryId/moduleName/enabled/fiberPhase/meta`）、`:168` 导出。

**本插件实现**：`listPlugins()` 先读 profile `package.json`（版本取 `node_modules/<pkg>/package.json`，未装时取依赖里具体版本号）与 `cordis.patch.yml`（`name` 行与 `insert[].name`），来源标记 `source: 'patch' | 'npm'`；文件不可读/为空才退到 `pluginInventory`；全部不可用返回 `[]` + warning。

**真实 profile 只读冒烟（2026-11-26，未写任何文件）**：`listPlugins()` 返回 29 行（npm 18 / patch 11），`warnings: []`。

未采用：只读 `dsh.profile.bundles` 当插件行——bundle 不等于运行时 loader 行；需要运行时视图时用 `pluginInventory`。

## ③ skills 来源

**可用**。

- 服务：`SkillRegistry` — `dsh-skill/lib/index.js:119`；服务名 `skills` — `:132`（`super(ctx, "skills")`）。
- 列表：`list(options = {})` — `dsh-skill/lib/index.js:224-225`（`snapshot(options).skills`）；`snapshot` — `:234-240`；`get(name, options)` — `:250`。
- 摘要字段：`toSummary(skill)` — `dsh-skill/lib/index.js:491-502`，含 `name/path?/description/whenToUse?/invocation/source/provider/resourceBase?`；排序在 `:237`。
- providers 由 `dsh-skill-filesystem` 等提供（`dsh-skill/lib/index.js:9-13` 注释）；该包就在提取清单内（证据根下 `dsh-skill-filesystem/`，含 `lib/`、`locale/`、`package.json`），但本任务不需要直接读它的目录。

**本插件实现**：`listSkills()` → `skills.list({})` → `{name, source: source ?? provider}`；返回数组排序稳定。

局限：不带 scope/cwd 时是全局层目录；项目级技能（cwd 敏感）需要在 Task 2 扫描工作区时传 `cwd`。

## ④ 会话事件来源（tool/call）

**可用**：用 `sessionQuery` 服务枚举会话并读完整事件日志。**禁止**手写 `.zstd` 解码（D12；实测单次 zstd 解压只出第一帧=header）。

- 服务：`SessionQueryEngine` — `dsh-session-query/lib/index.js:1078`；服务名 `sessionQuery` — `:1084`（`super(ctx, "sessionQuery")`）。
- `listSessions(signal)` — `dsh-session-query/lib/index.js:1119-1121`；实际读取 `SessionCorpus.listSessions` — `:95-117`，记录形如 `{ header: { id, createdAt, cwd, parentSession, ... }, live, persisted, formatStatus }`；**会话 id 在 `record.header.id`**。
- `readSession(sessionId)` — `dsh-session-query/lib/index.js:1128-1136`，返回 `{ session: 克隆 header, inheritedEventCount, events: SessionEvent[] }`（完整事件，含 `data`）。
- `listEvents(sessionId)` — `dsh-session-query/lib/index.js:1190-1192` → `eventRecords` `:883-884` → `analyzeEventLog` `:984-1016`；记录只有 `{ sessionId, seq, type, time, surface }`（`:1005-1011`）——**没有 `data`，不能用来取工具名**。
- `tool/call` 事件的持久化结构：`dsh-tools/lib/types/batch.js:210-212` 写入 `{ turn, step, callId, name, arguments }`；工具名字段是 `event.data.name`（旁证：`dsh-session-query/lib/index.js:585` `case "tool/call": return joinText([event.data.name, event.data.arguments])`）。
- 事件时间戳是 `event.time`（毫秒 epoch，配对用法见 `dsh-session-stats/lib/types/projection.js:123-124`）；事件类型登记在 `dsh-session/lib/types/known-event-types.js:75`（`'tool/call'`）。

**本插件实现**：`sessionEvents(sinceISO?)` 返回 `AsyncIterable<{tool, at, sessionId}>`：`listSessions()` →（F5：给了 `sinceISO` 时先用 `header.createdAt` 预过滤窗口外会话，缺失 `createdAt` 保守保留）→ 逐会话 `readSession(id)` → 过滤 `type === 'tool/call'` → `tool = data.name`、`at = new Date(event.time).toISOString()`、`sessionId = header.id`；`sinceISO` 仍按 `event.time` 做精确过滤。服务不可用返回 **null**（不抛错）。

性能备注：Task 0 不缓存；Task 2 统计近 30 天时先做时间窗裁剪/按会话时间排序，避免全量 `readSession`。

## ⑤ client 槽位与「往输入框塞草稿」

### 槽位（可用）

- 模块加载契约：宿主在 HTML 头部注入 `window.__ModuleLoader__`，queue 模式 `load(registration){ pendingQueue.push(registration) }` — `dsh-client-modules/lib/index.js:518-540`（`:521-524` 为 queue；`:525-537` 为 boot 时 `create`，`factory(specifier => ...)` 在 `:531`）；模块系统说明 `:42-48`（`window.__ModuleLoader__.load({id, factory})`）。
- `slots` 服务：client 根 ctx `inject: ['slots']`；`ctx.slots.inject(slotName, factory)` + `ctx.slots.register({ name, id|key, order, label }, component)` ——WhaleBuddy 已在本机 0.2.2-rc.5 验证：`dsh-whalebuddy/lib/client.js:2822`（`inject: ['slots']`）、`:2844-2846`（slots 缺失只 warn）、`:2857-2871`（`sidebar.panellist` 行 + `main` 页注册）、`:2892-2898`（loader 注册）。
- 槽位名：
  - `sidebar.panellist`：左侧栏的面板行（`dsh-whalebuddy/lib/client.js:15-24` 注释 + 常量 `:35-38`）；sidebar 客户端 bundle 内也含该字面量（`dsh-client-ui-sidebar/lib/client.js:2`，单行打包文件）。
  - `main`：主区页面，`key` 与行 `id` 相同（`dsh-whalebuddy/lib/client.js:37`、`:2867-2871`）。
- 已装插件同契约样例：`@linxin666/dsh-client-ui-skill-explorer/lib/client.js:1-3`（同一 `window.__ModuleLoader__.load({id, factory})` 形态）。
- **本插件**：`dsh.client = { platform: 'web', inject: [] }`（D4，照 WhaleBuddy）；`client.js` 用 loader 注册 `sidebar.panellist` 行「归置」+ `main` 三屏面板（清爽 / 场景 / 地图，真机三屏验证步骤见 [docs/DEMO.md](DEMO.md) §4.2）；slots 缺失只 `console.warn`，不抛错。

### 往对话输入框塞草稿：**不可用**

- 在提取的宿主源码与已装插件里按「输入框草稿」语义 grep `draft`/`setDraft`/`insertDraft`/`composer`：**无相关命中**（sidebar bundle 无 `draft`/`composer`；`composer` 只命中 `dsh-plugin-manager` 的 profile patch composer（同一功能，`lib/types/patch.js:6` 与 `lib/index.js:1176` 两处），与对话输入框无关）；`dsh-client-ui-chat` 不在提取清单内，无法核对内部状态 API；已装插件（whalebuddy、skill-explorer、better-sidebar）也没有「写输入框」的用法——只见到 `uiWorkspace.startSession` 开新会话（`dsh-whalebuddy/lib/client.js:2829-2849`；已装 better-sidebar 亦有 `ctx.get("uiWorkspace")`）。
- 结论：**没有公开、稳定的「宿主输入框草稿」API**。v1 桥 1 兜底方案（设计 §5 降级）：面板生成「派单草稿」文本 → `navigator.clipboard.writeText` 复制 → 用户自己粘贴/发送；不假装能直接塞输入框。

## ⑥ 注册 HTTP 路由的 API

**可用**。

- 服务：`WebServer` — `dsh-host-webserver/lib/index.js:298`（`class WebServer extends Service`）；服务名 `webServer` — `:335`（`super(ctx, "webServer")`）。
- 注册：`register(route)` — `dsh-host-webserver/lib/index.js:375-382`；`route = { kind: 'exact' | 'prefix', path, handler }`，返回 disposer；重复 `(kind, path)` 直接抛错（`:377`）。
- 分发：`await responder.handler(req, res)` — `dsh-host-webserver/lib/index.js:471`（handler 拥有完整响应生命周期，类型见 `node:http` 的 IncomingMessage/ServerResponse）。
- 生命周期：路由注册**不**自动绑定 cordis effect，必须 `scope.effect(() => scope.webServer.register(route), label)` 才随插件卸载回收（WhaleBuddy 写法：`dsh-whalebuddy/lib/index.js:1296-1301`）。
- 路径约定：宿主 origin 根绝对 `/api/<plugin>/...`；**客户端必须 document-relative** `api/<plugin>/...`（宿主以 `<base href="./">` 部署，根绝对会逃出子路径前缀）——已装 skill-explorer 的注释证据：`@linxin666/dsh-client-ui-skill-explorer/lib/client.js:15-21`；WhaleBuddy 同样说明：`dsh-whalebuddy/lib/host/routes.js:11-16` 与客户端 `dsh-whalebuddy/lib/client.js:45-49`。
- 访问围栏：可选 `connection` 服务 `requestRejection(request)`；缺失时退回 loopback 判断 —— `dsh-whalebuddy/lib/host/routes.js:77-121`（`isLoopbackRequest` :77、`resolveConnection` :87、`isConsoleRequestAllowed` :104）。
- 其他 API（未采用）：`registerUpgrade` — `:389-395`；`registerFallback` — `:405-411`（单占位，不能多插件共享）。

**本插件 Task 0**：**不注册任何 HTTP 路由**（`lib/index.js` 只注册 `stow_probe`）；路由将在 Task 7 以 `/api/guizhi` 前缀实现并有测试。上面这段宿主契约已核对，Task 7 接线时按 `scope.webServer.register` + `scope.effect` 的形状写；因此 Task 0 没有可 curl 的端点。

## 其他关键事实

- **profilePath()**：优先 `ctx.get('profileContext').dir`（来源见 ②）；兜底 env `DSH_PROFILE` / argv `--profile <name>` + `$DSH_HOME`（默认 `~/.dsh`）。`DSH_HOME` 解析规则宿主侧见 `dsh-home-paths/lib/index.js:100-112`（最高优先显式配置，其次 `$DSH_HOME`，再次 `~/.dsh`）。
- **dshVersion()**：宿主**没有**暴露「运行时版本」服务（`profileContext` 字段清单无 version：`dsh/lib/profile-boot-QhDEDXsF.js:301-312`）；版本由 CLI 启动层的 `getDshRuntimeVersion()` 取得（`dsh/lib/bin-CwxESKe-.js:2` import、`:207` 调用），不在插件可达的服务面。本插件探测顺序：env `DSH_CLIENT_VERSION`/`DSH_VERSION` → 从 `argv[1]/argv[0]/execPath` 向上 8 层找 `name ∈ {@deepseek-ai/dsh, dsh, dsh-cli}` 的 package.json → `'unknown'`。该做法与已装插件 `dsh-whale-widget/lib/index.js:3810-3847`（`dshVersionOf()`）一致；不可保证命中，故状态记 **部分可用**。
- **HostAdapter 的 `warnings` / `takeWarnings()`（additive，文档化）**：六方法接口不变，额外提供只读 `warnings` 快照（每次读取都是新数组，不暴露内部队列）与 `takeWarnings()`（取走本批警告并清空内部队列）。`probeHost` 每次调用先清空、结束后取走本批警告并放进返回值的独立数组，所以连续多次探测不会累积、第二次结果不受第一次污染；单次探测内的降级/失败记录（含 adapter 方法内部记录的）都保留在该次 `result.warnings` 里。
- **launch environment 服务**：宿主还 provide `DSH_LAUNCH_ENVIRONMENT_KEY`（`dsh/lib/profile-boot-QhDEDXsF.js:316`），但该包（`@deepseek-ai/dsh-launch-environment`）不在提取清单，字段未核对，本任务不用。
- **tools 注册/定义形状**：`defineTool` 的 `output` 必须 `{ schema, render }`，render 返回 `[{ type: 'text', text }]`（`dsh-tools/lib/index.js:310-359`；输出 schema 投影 `:366-381`）。本插件 `stow_probe` 照 WhaleBuddy 已跑通的形状写。

## 8. 验证状态（D5：不修改真实 profile / 不重启 DSH）

- 任务书 Step 5「装进测试 profile 并重启验证」：**not-run**（按 D5）。本任务未执行 `dsh plugin --profile ...`、未创建/写入任何 profile、未重启 DSH、未起第二个服务；也未注册任何 HTTP 路由（Task 0 无端点）。
- 已完成的替代验证：
  - 契约核对：上文全部结论均带 文件:行号 证据。
  - 单元测试：`node --test test/*.test.js` → 13/13 PASS（fake ctx 覆盖服务齐全、缺失/抛错降级、patch 解析失败、warnings 快照不累积、profile 兜底）。
  - 语法校验：`node --check lib/index.js`、`node --check client.js`、`node --check lib/host.js`、`node --check lib/probe.js` 全过。
  - 真实 profile **只读**冒烟：`listPlugins()` 读 desktop profile → 29 行（npm 18 / patch 11），`warnings: []`，未写任何文件。
- **手动验证步骤（留给人，本轮仍 not-run；安装命令与启动命令成对，端口从启动输出/浏览器地址获得）**：

  **第 0 步：拿到本机 CLI（不在 PATH，用安装包自带入口）**
  - 本机安装目录 `F:\DSH_offical`，入口 `F:\DSH_offical\resources\runtime\cli\bin\dsh.cmd`。该 `dsh.cmd` 以 `ELECTRON_RUN_AS_NODE=1` 调 `DeepSeek Harness.exe --expose-internals app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`，所以不依赖 PATH 里有 `dsh`。
  - 自检：`"F:\DSH_offical\resources\runtime\cli\bin\dsh.cmd" --version` → 期望 `0.2.2-rc.5`（本机基线）。

  **第 1 步：创建测试 profile（只碰 guizhi-test，不碰 desktop / web）**
  - 创建 + 启动：`"F:\DSH_offical\resources\runtime\cli\bin\dsh.cmd" --profile guizhi-test --from-default-profile web`
  - 它把随包 web 模板（bundle 列表 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，见本机 `~/.dsh/profiles/web/package.json`）复制成 `%USERPROFILE%\.dsh\profiles\guizhi-test`，然后启动该 profile 的 Web GUI。宿主实现 `initializeProfileFromDefault`（`dsh/lib/profile-boot-QhDEDXsF.js:147`）先写 `.<name>.staging-*` 再 rename，失败会还原，不会留半个 profile。
  - **只在首次创建时带 `--from-default-profile web`**；以后启动不要带，否则会用模板重建 profile、已装插件被清掉。
  - 看到 Web GUI 后在本终端 Ctrl+C 退出，继续第 2 步。

  **第 2 步：把仓库装进测试 profile**
  - `"F:\DSH_offical\resources\runtime\cli\bin\dsh.cmd" plugin --profile guizhi-test add "F:/归置"`
  - `plugin` 子命令把剩余参数原样转给 pnpm（`dsh/lib/bin-CwxESKe-.js:116`），且该 profile「首次使用时初始化」（同一行帮助文本）；绝对本地目录是插件管理器接受的安装 spec（`dsh-plugin-manager/lib/types/tools.js:11`：npm 包名 / git URL / tarball URL / 绝对本地目录）。
  - 期望：pnpm 安装成功；`%USERPROFILE%\.dsh\profiles\guizhi-test\node_modules\` 下出现 `@fanyingnie/dsh-guizhi`，且 bundle/插件列表出现该 bundle。

  **第 3 步：用测试 profile 启动 DSH**
  - `"F:\DSH_offical\resources\runtime\cli\bin\dsh.cmd" --profile guizhi-test`
  - **端口怎么获得**：Web 应用启动时会打印一条带 token 的 URL，并默认自动打开默认浏览器（`@deepseek-ai/dsh-web-app` 包 README：Startup prints a tokenized URL and normally opens the default browser；`--no-open` 可关闭自动打开）——端口就在这条 URL / 自动打开的浏览器地址栏里。本机当前 desktop 实例的 GUI 地址是 `http://127.0.0.1:65239`，重启后会变，仅作对照。Task 0 **没有** HTTP 路由，不需要 curl 任何 `/api/guizhi/*`（路由在 Task 7 实现并有测试）。
  - **注**：desktop profile 由 Electron 应用独占（CLI 拒绝管理/启动 desktop，`dsh/lib/bin-CwxESKe-.js:35`）；`guizhi-test` 是自定义 profile，可这样启动；验证期间已开的 Desktop 可以同时存在、互不干扰。
  - **如何确认插件已加载**：① 设置（Settings）左侧出现「插件」分区（`dsh-client-ui-settings-plugins` 注册 `settings.section` id=`plugins`、order=15）；② 插件/bundle 列表出现 `@fanyingnie/dsh-guizhi` 且启用；③ 左侧栏出现「归置」行；④ 启动日志若报告被跳过的 bundle（`reportSkippedBundles`，`dsh/lib/profile-boot-QhDEDXsF.js:217-225`）说明该 bundle 未挂载。

  **第 4 步：面板与工具**
  - 点开侧栏「归置」：按 [docs/DEMO.md](DEMO.md) §4.2 的三屏验证步骤检查（清爽 / 场景 / 地图 三屏可切换、扫描后数字变化、用量未知显示「未知」、地图页能力点可展开证据、生成工具包结果区为提案语义）；不再只验证「标题 + 版本」的最小面。
  - 会话里调用 `stow_probe`，返回 `{tools, plugins, skills, sessionEvents, profilePath, dshVersion, warnings}`；记录实际 `tools/plugins/skills` 数量与 `dshVersion`（若为 `unknown`，把运行时可探测到的信息补进本文件「其他关键事实」）。

- 未验证项（not-run，不是 pass）：面板真机渲染、`stow_probe` 在 agent 工具面中的注册与调用、`sessionEvents` 对真实会话日志的读取与性能、Task 7 的 `/api/guizhi` 路由真机可达性。

### 8.1 真机首启失败与修复（2026-11-26，desktop profile）

- 现象：CLI 安装 + 重启 Desktop 后，左侧栏没有「归置」行，工具面也没有 stow_*；reportSkippedBundles 无输出（bundle 层已合成）——说明 loader 行存在，但 import 失败。
- 定位：用 @deepseek-ai/dsh-app-boot 在 Electron-Node 里只装载 guizhi 行做隔离启动，复现：
  guizhi (@fanyingnie/dsh-guizhi): failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tools' imported from F:\归置\lib\index.js。
- 根因：本插件以 link:F:/归置 安装，属于 linked root。宿主的运行时包路由（dsh-app-boot/lib/index.js 的 ResolutionRouter.routeLinked + readPeerNames）只对「某个祖先 package.json 的 peerDependencies 里声明过」的包名做安装域拦截；此前本包只有 engines.dsh 与 dependencies.yaml，未声明 @deepseek-ai/dsh-tools，于是落回 Node 原生解析并失败。engines.dsh 能满足兼容性检查，但决定不了模块解析。
- 修复：package.json 增加 peerDependencies: { "@deepseek-ai/dsh-tools": ">=0.2.2-rc.2 <0.3.0" }（兼容性仍由 engines.dsh 单独裁决）。
- 回归：test/packaging.test.js 断言该 peer 声明、各入口文件存在、client.js 的 loader 注册 id 与包名一致。
- 复核证据（隔离启动，同日）：修复前 guizhi 行 failed to import；修复后 guizhi 行 fiber state=2（ACTIVE），日志 0 条 warn/error。同批对照：dsh-ops、dsh-client-ui-weave ACTIVE；dsh-plugin-guide、dsh-context、brooks-lint 仅 pending 等待其必需服务。真实 Desktop 重启后的面板/工具验证仍需按 §8 手动步骤补做（修复未重启用户实例）。

## 9. 相对任务书的决策记录（与裁决一致的偏离）

- D1：不创建根 `index.js`（`package.json` main/exports 指向 `./lib/index.js`）。
- D2：额外提供最小 `icon.svg`（exports['./icon'] 已引用）。
- D3：`cordis.patch.yml` 的 insert 行只写 `id`/`name`，不写 `inject`；`lib/index.js` 导出 `inject = []`，可选服务用 `ctx.inject([...], cb)`，其余用 `ctx.get` 保护式读取。
- D4：`dsh.client = { platform: 'web', inject: [] }`；`client.js` 照 WhaleBuddy loader 形态。
- D5：Step 5 改为契约核对 + not-run 手动步骤（见 §8）。
- D8：`listTools()` 只给 name/description，owner 留空（见 ①）。
- D10：`package.json.dsh` 补 `capabilities: ['fs:read','fs:write','network:ingress','sessions:read']` 与 `labels: []`。
- D11：仅 `lib/index.js` import `@deepseek-ai/dsh-tools`；测试只 import `lib/host.js`/`lib/probe.js`。
- D12：`sessionEvents` 走 `sessionQuery`（`listSessions` + `readSession`），不手写 `.zstd` 解码（见 ④）。
- D15：`pnpm install` 生成并提交 `pnpm-lock.yaml`（yaml 2.9.1）。
- 附加（超出任务书的最小项）：无。`GET /api/guizhi/health` 按裁决整体删除，HTTP 路由留给 Task 7（`/api/guizhi` 前缀、带测试）；HostAdapter 的 `warnings` / `takeWarnings()` 为文档化的 additive 诊断扩展（见「其他关键事实」），六方法接口不变。
