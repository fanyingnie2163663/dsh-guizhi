# 归置（Stow）· 演示脚本与 v1 验收记录

- 日期：2026-11-26
- 分支：v1；Task 8 BASE：7a7c905
- 相关代码：[routes.js](../lib/routes.js)、[apply.js](../lib/apply.js)、[client.js](../client.js)、[e2e.test.js](../test/e2e.test.js)
- 本文件同时是「演示脚本」与「设计文档 §11 验收」的证据记录。真机安装/重启/面板/录屏在本机为 **not-run**（禁止重启宿主、禁止改真实 profile），凡 not-run 一律不写成 pass。

状态记号：**PASS** = 自动化测试/只读冒烟已给证据；**PARTIAL** = 链路有测试证据但真机项 not-run 或验收子项未实现；**NOT-RUN** = 本任务未执行，附手动步骤。

---

## 1. 60 秒演示脚本

### 1.1 录屏前准备（一次性）

1. 真机安装（**需用户手动**，见 §4.1）：插件进 profile，重启 DSH，侧栏出现「归置」行。
2. 数据根：约定为 `$DSH_HOME/guizhi`（fallback 链见 §5）。目录源可选：写 `<数据根>/sources.json`：
~~~json
{ "catalog": { "url": "https://example.com/format-1-index.json" } }
~~~
   不配也能演示：查缺补漏会返回明确 error（fail-open），不会假装「你没有缺口」。
3. 地图：v1 面板只读已保存地图，演示前先在会话里让 agent 调 `stow_map_save`（参数 map 见 §5.3），或手工放一份合法 `map.json`。地图建议 2 个阶段、至少 1 个 `missing` 能力点。
4. 建议录屏前先点一次「重新扫描」，避免首屏是未扫描空态。

### 1.2 分镜（0:00 – 1:00）

| 时间 | 画面 / 操作 | 旁白要点 |
|---|---|---|
| 0:00–0:08 | 侧栏面板行「归置」→ 主区「清爽」页。扫描后四张卡片：插件 / 工具 / 技能 / 近 30 天未用；下方工具表（名称、owners、近 30 天用量） | 「先看家底。插件、工具、技能一目了然；用量未知就显示『未知』，绝不写成 0。」 |
| 0:08–0:16 | 切「场景」页。点「研发」「内容生产」两个 chip，自定义一句「给研发团队做内部小工具」，点「保存场景」 | 「工作流先选场景；场景只写本机状态，不调模型、不生成工作流。」 |
| 0:16–0:30 | 切「地图」页：两张阶段卡（理解需求 / 交付），能力点绿（已有）/ 黄（缺）/ 灰（冗余）。点黄色「联网搜索」 | 「地图按阶段摊开能力点。点一下能力点，证据展开：来源、工具、近 30 天用量、最后使用时间。」 |
| 0:30–0:38 | 点「查缺补漏」。结果区出现安装提案（如 dsh-web-search），带来源与说明 | 「缺的部分来自公共目录；目录不可达会报错，不会显示成『没有缺口』。」 |
| 0:38–0:47 | 点「生成工具包」（stageIds = 全部阶段）。结果区显示包 id、导出路径、工具数 / 技能数 / 阶段数；再点「预览变更」显示条目与 hash | 「工具包是一份可读的 JSON：阶段、工具、技能、生效要求都在里面。预览给出稳定 hash，确认前不动任何东西。」 |
| 0:47–0:56 | 点「应用」：显示 applied、snapshotId、warnings（v1 对 install 提案只提示不安装）；点「回滚」：restored，状态栏恢复 | 「应用前先写快照；v1 只导出包、不写 profile。回滚删除本次记录的包文件并恢复状态，重复回滚也不报错。」 |
| 0:56–1:00 | 点「生成派单草稿」→ 文本区显示「这个活只需要 A / B / C」，点「复制到剪贴板」 | 「派单草稿只是给会话的软约束，面板不会代发、不会塞进输入框。全部只读，写操作先预览、先快照、可回滚。」 |

### 1.3 60 秒必须讲清的四件事（对应设计 §11 #6）

1. **我的家底**：插件 / 工具 / 技能 / 近 30 天未用 + 每个工具的归属与用量（未知 ≠ 0）。
2. **我的工作流**：场景多选 → 阶段化地图 → 能力点状态。
3. **缺什么**：缺口提案来自公共目录、可解释、可失败（fail-open 明示 error）。
4. **派出去的那个只带 5 个工具**：v1 是「派单草稿 + 工具包声明」（文本软约束，不实际限制工具面）；演示可在草稿/包的工具列表里指出前 5 个。硬限制工具面是 v-next（设计 §13），不要宣称已隔离工具。

---

## 2. 设计 §11 验收清单（8 条）

| # | 验收条（设计 §11） | 状态 | 证据 | 缺口 / 手动步骤 |
|---|---|---|---|---|
| 1 | 在装了不少于 20 个插件的真实 DSH 上：扫描 10 秒内出结果（第二次缓存后更快） | **PARTIAL** | 真实 desktop profile 只读冒烟：30 插件（19 npm / 11 patch）、88 工具、scan 冷 240ms、归因 246ms、整链 987ms，均远小于 10s（§3） | 「缓存后更快」**未实现**：v1 没有扫描结果缓存，第二次 scan 仍 ~234ms；面板靠轮询 GET state 读已落盘 scan.json，不重复扫描。真机宿主内扫描 not-run（手动步骤 §4.2-5）。见 issue 1 |
| 2 | 地图页每个能力点都能点出证据（插件、次数、时间） | **PARTIAL** | e2e 断言 map 能力点 evidence 对象持久化并可读回（scan 证据含 source / tools / used30d / lastUsedAt），client 地图页点击能力点展开 evidence（中文 label 映射） | 证据字段由地图制作者写入（schema 允许开放 evidence 对象）；「自动把 scan 事实填进 map」未实现。真机面板 not-run（§4.2-2） |
| 3 | 任一建议能生成包并预览；确认后应用成功，回滚成功 | **PARTIAL** | e2e 全链路：pack 路由真实 buildPack+exportPack 写 packs/<id>.json；preview 同输入同 hash、ids 过滤；apply 建快照（tag before-apply）+ 先写 packs-created.json 台账再导出包；rollback 删台账包文件 + store.restore 恢复状态、重复回滚幂等；测试 3/3、全量 240/240 通过 | 生产链路的 gaps 只产生 install 提案，没有生成 kind=pack 提案的接口，因此**面板的「应用」目前只会对 install 给 warning、不会写包**；e2e 为覆盖 apply 的 pack 分支，用真实 store 种入一条 kind=pack 提案（见 issue 2）。真机面板 not-run（§4.2-2/5） |
| 4 | 包能导出成文件、人能读懂；显式勾选安装时，插件行安装成功并提示「需要新会话 / 重启」 | **PARTIAL** | 导出 ✅：e2e 断言 packs/<id>.json 内容与 pack 一致、schemas.pack 合法、pretty JSON（标题 / stageIds / tools / skills / requirements.appliesAt=new-session） | 安装 **v1 不做**（D7 裁决：apply 只写 pack 文件，install/skill 只 warning）；v1.1 显式勾选安装与「需要新会话 / 重启」提示 not-run（§4.2-7） |
| 5 | 每个能力点标出生效方式；「需单开会话」的插件有明确徽章和手动步骤 | **NOT-RUN（未实现）** | 无 | D7 map 形状没有「生效方式 / ownSession」字段，client 无徽章；属 v1 未实现范围（设计 §7/§11 要求，计划未落到任务）。建议后续：evidence 增 appliesAt/ownSession 并在面板加徽章与手动步骤文案；临时演示可在 evidence 里手写 note 说明 |
| 6 | 60 秒录屏能讲清：家底 → 工作流 → 缺什么 → 派出去的那个只带 5 个工具 | **PARTIAL** | 脚本就位（本文 §1），流程与按钮均为 client.js 真实文案 | **录屏 not-run**：需在真机安装后由人录制（§4.2-6） |
| 7 | 给 3 个已有自己配置的 DSH 用户看，至少 2 人问「怎么装的」 | **NOT-RUN** | 无 | 用户测试 not-run（§4.2-6），需真人参与 |
| 8 | 全流程不依赖 rc 版本的内部语义（不调 restrict、不挂钩子、不改预设） | **PASS**（静态 + 测试证据） | e2e 与各单测只调用 lib 公开函数与路由 handler；lib 内 grep 无 restrict / agentPresets / 预设写入；写操作只落在数据根；node --check lib/index.js / client.js 通过；D11：仅 lib/index.js import @deepseek-ai/dsh-tools | 真机 not-run；宿主 API 兼容性以 docs/host-notes.md 的契约核对为准 |

---

## 3. 真实 profile 只读冒烟（§11 #1 的近似证据）

- 方法：一次性脚本（不提交；位于 gitignore 的 .superpowers/ 下）调用 lib/host.js 的 createHostAdapter（ctx 桩，仅读 profile 文件）+ lib/attribution.js 的 attributeTools/withAttribution + lib/usage.js 的 summarizeUsage + lib/scan.js 的 scanFacts。**不启动宿主、不写 profile、不写数据根**。
- profile：C:/Users/Administrator/.dsh/profiles/desktop；数据根在冒烟前后均不存在（guizhiDataRootBefore=false / After=false），profile/package.json mtime 前后一致。
- 命令（在仓库根执行）：`node .superpowers/sdd/2026-11-26-guizhi-v1/t8-smoke.mjs`

| 指标 | 实测 |
|---|---|
| 插件 | 30（npm 19 / patch 11） |
| 工具（当前会话工具面，宿主未启动所以非桌面 profile 运行时工具表） | 88 |
| 归因结果 | 88 行，其中 38 个工具有 owner（2 个 owner：dsh-ego-browser 37、@deepseek-ai/dsh-experimental-tool-worktree 1） |
| 技能 | 宿主 skills 服务不可用 → 0 + warning（降级不静默）；文件系统旁证 ~/.dsh/skills 下 10 个 SKILL.md（非 host 真值） |
| 用量 | unknown=true（sessionQuery 服务不可用，不写 0） |
| scan schema | 校验通过 |
| 耗时（ms） | 插件枚举 冷 13 / 热 7；归因 246；withAttribution.listTools 245；usage 0.2；scanFacts 冷 240 / 热 234；整条扫描链 987 |
| 归因告警 | 8 个插件源码扫描截断（200 文件 / 1MB 上限）；50 个工具无法归因（不虚构来源，汇总一条 warning） |

结论：**扫描 < 10s 达标**（240ms 级）；「缓存后更快」不达标（无缓存，见 issue 1）；归因覆盖 38/88 属 v1 已知上限（issue 5）。注意这是「无宿主、当前会话工具面」的近似，真机宿主内 stow_scan 尚未执行（§4.2-5）。

---

## 4. not-run 清单与手动步骤

### 4.1 为什么 not-run

本会话运行在真实 DSH 内；任务约束（D5）禁止重启宿主、禁止修改真实 profile、禁止起替代服务，因此所有「安装生效后」的验证都在本任务停止，等用户执行。

### 4.2 手动步骤

1. **安装插件（用户执行）**：把 @fanyingnie/dsh-guizhi 装进 desktop profile（pnpm add file: 或复制到 profile/node_modules），并在 profile 的 cordis.patch.yml 增加一行（id: guizhi / name: @fanyingnie/dsh-guizhi）。注意：本任务未执行，也不建议直接改生产 profile；建议新开一个测试 profile。
2. **重启 DSH（用户执行）**：重启后侧栏出现「归置」面板行，主区「清爽 / 场景 / 地图」三屏可切换；slots 缺失只 console.warn，不应有 console.error。
3. **工具面（用户执行）**：新会话应出现 9 个工具 stow_scan / stow_status / stow_map_save / stow_pack_build / stow_gaps / stow_preview / stow_apply / stow_rollback / stow_draft；逐个调用一次，业务失败应返回 {ok:false,...} 文本而不是崩溃。真机注册尚未验证（Task 7 只做了宿主 defineTool 编译冒烟 9/9 allOk，不是运行注册）。
4. **路由（用户执行，只读）**：GET http://127.0.0.1:<宿主端口>/api/guizhi/state 应返回 {scan,map,proposals,selections,warnings}；非 loopback 请求应被围栏拒绝。
5. **≥20 插件真机扫描（用户执行）**：在宿主内点「重新扫描」或调用 stow_scan，记录：插件数 / 工具数 / 技能数 / 归因数 / 每步耗时；第一次扫描应 ≤10s（本任务只读近似 240ms，但真机含会话日志用量统计会更慢），第二次是否更快（当前实现没有扫描缓存 → 预期相近，记 issue）。
6. **60 秒录屏与用户测试（用户执行）**：按 §1 录制；找 3 位已有自己 DSH 配置的用户看，记录是否有人问「怎么装的」。
7. **v1.1 安装与生效方式（未来任务）**：显式勾选安装插件行（写 profile 前预览 + 快照 + 回滚 + 「需要新会话 / 重启」提示）；能力点生效方式与「需单开会话」徽章（§11 #4/#5）。

---

## 5. 关键契约（给未来维护者）

### 5.1 前缀与命名

- 插件 id：guizhi；包名：@fanyingnie/dsh-guizhi。
- 工具前缀：stow_，共 9 个（见 §4.2-3）。
- 路由前缀：/api/guizhi，root-absolute；客户端 fetch 必须 document-relative（api/guizhi/...，宿主以 <base href="./"> 部署）。
- 路由（10 条，见 [routes.js](../lib/routes.js) ROUTE_PATHS）：GET state；POST scan / scenarios / map / pack / gaps / preview / apply / rollback / draft。

### 5.2 数据根（D16 修订后的 fallback 链）

1. 宿主服务 dshHomePath('guizhi')（存在且返回非空时）；
2. profileContext.home + /guizhi；
3. $DSH_HOME/guizhi（或显式 home 选项）；
4. ~/.dsh/guizhi。

文件布局（1MB/文件上限，全部原子写：临时文件 + rename）：

~~~
<数据根>/scan.json          最近一次扫描（D7 scan）
<数据根>/map.json           工作流地图（D7 map，R-4A 允许 stage.tools/skills）
<数据根>/proposals.json     { items: Proposal[], generatedAt }
<数据根>/selections.json    { selected: string[], custom: string }
<数据根>/sources.json       目录源配置（可选）
<数据根>/packs/<id>.json    导出的能力包
<数据根>/snapshots/<id>/    状态副本 + meta.json + packs-created.json（apply 台账）
<数据根>/catalog/           目录缓存（index-<sha256 前16>.json）
~~~

### 5.3 契约形状（D7 + 修订）

- map = { scenarios, custom?, stages: [{ id, title, capabilities: [{ id, title, status: have|missing|redundant, evidence: object }], tools?, skills? }] }，stage id 唯一（R-4A）。
- pack = { version:1, id, title, createdAt, stageIds, rows:[], tools:[], skills:[], items:[], requirements:{appliesAt:'new-session',ownSession:false} }；id = pack- + sha256(title+stageIds) 前 8 hex（确定性）。
- Proposal = { id, kind: 'install'|'pack'|'skill', title, effect, evidence:{source, refs?} }。
- scan = { plugins, tools[{name,description,owners[],used30d:number|null,lastUsedAt}], skills, totals{plugins,tools,skills,unusedTools}, warnings, generatedAt }；用量未知时 used30d=null 且 unusedTools 只统计已知 0。
- preview 的 hash = sha256(canonical JSON(选中 items 的 id/kind/title/effect))。

### 5.4 v1 行为裁决（写代码前先读）

- **apply 只写 pack 文件**；kind install/skill 只给 warning，绝不写 profile（D7）。写盘顺序：先快照 → 先写台账 packs-created.json（列全部计划路径）→ 再 exportPack（R-6A，崩溃也不留不可回滚的孤儿包）。
- **rollback** = 按台账删本次包文件（缺失跳过、只删 <数据根>/packs 内路径）+ store.restore；幂等。
- **gaps 无地图 = 400 NO_MAP 且不写 proposals**（R-7A）；目录不可达 fail-open 返回 items [] + error，仍写 proposals。
- **v1 不写 profile、不改预设、不调 restrict/钩子**；不调模型 API；外部目录数据只当数据，schema 校验 + 缓存 + fail-open。
- D11：**只有 lib/index.js 可以 import @deepseek-ai/dsh-tools**；测试不得 import lib/index.js。

### 5.5 验证命令

~~~bash
node --test test/e2e.test.js     # 全链路验收：3/3 通过
node --test test/*.test.js       # 全量：240/240 通过
node --check lib/index.js && node --check client.js
~~~

---

## 6. 已知缺口 / issue 列表（v1 不阻塞，交后续分诊）

1. **没有扫描缓存**：§11 #1 的「第二次缓存后更快」不满足；面板靠读 scan.json 呈现，不重复扫描。真机耗时需在宿主内复测。
2. **pack 提案来源缺口（重要）**：生产链路只有 gaps 的 install 提案，没有任何接口/工具写入 kind=pack 提案；而 apply/rollback 的「写包 + 回滚包」分支只对 kind=pack 提案生效。结果：面板「生成工具包」导出的包不在快照/回滚保护范围内。e2e 用真实 store 种入一条 pack 提案覆盖了 apply 分支。建议：新增提案保存入口（工具/路由）或在生成包时同步写一条 pack 提案。
3. **§11 #5 未实现**：能力点生效方式、「需单开会话」徽章与手动步骤。
4. **§11 #4 安装未实现**：v1 按 D7 只导出，安装与「新会话 / 重启」提示留 v1.1。
5. **归因覆盖 38/88**：静态归因受 200 文件 / 1MB / 仅 npm 插件限制；无法归因的工具汇总一条 warning，不虚构来源。
6. **无宿主冒烟中 skills 服务不可用**：技能数只能用文件系统旁证（10），真机需以 skills 服务为准。
7. **真机未验证项**：安装、重启、面板三屏、9 工具注册、路由挂载、≥20 插件宿主内扫描、录屏、用户测试（见 §4）。
