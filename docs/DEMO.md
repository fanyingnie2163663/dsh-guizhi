# 归置（Stow）· 演示脚本与 v1 验收记录

- 日期：2026-11-26
- 分支：v1；Task 8 BASE：7a7c905；T8.5（R-PACK 闭合 pack 提案链）在 784960b 之后提交
- 最终修复波：BASE 23c3754，F1-F7（R-6B 回滚数据丢失 / R-8A preview-apply 一致性 / DEMO format-1 / spec 承诺裁决 / 用量窗口下推 / HTTP 适配抽测 / client 文案与便宜 Minor），见 [task-final-fix-report.md](../.superpowers/sdd/2026-11-26-guizhi-v1/task-final-fix-report.md)
- 相关代码：[routes.js](../lib/routes.js)、[apply.js](../lib/apply.js)、[store.js](../lib/store.js)、[http.js](../lib/http.js)、[client.js](../client.js)、[e2e.test.js](../test/e2e.test.js)
- 本文件同时是「演示脚本」与「设计文档 §11 验收」的证据记录。真机安装/重启/面板/录屏在本机为 **not-run**（禁止重启宿主、禁止改真实 profile），凡 not-run 一律不写成 pass。

状态记号：**PASS** = 自动化测试/只读冒烟已给证据；**PARTIAL** = 链路有测试证据但真机项 not-run 或验收子项未实现；**NOT-RUN** = 本任务未执行，附手动步骤。

---

## 1. 60 秒演示脚本

### 1.1 录屏前准备（一次性）

1. 真机安装（**需用户手动**，见 §4.1）：插件进 profile，重启 DSH，侧栏出现「归置」行。
2. 数据根：见 §5.2 的解析链；下文用 `<数据根>` 指代实际落点。
3. **目录源：演示「查缺补漏」必配**。写 `<数据根>/sources.json`，指向一个可访问的 format-1 目录索引；索引形如 `{ "format": 1, "plugins": [ { "name", "title", "description", "version"? } ] }`（与 lib/catalog.js 的 parseFormat1 及 [test/fixtures/index.json](../test/fixtures/index.json) 一致；根对象必须带 `plugins` 数组，不是 `entries`）：
~~~json
{ "catalog": { "url": "https://example.com/format-1-index.json" } }
~~~
   **格式核对状态（诚实说明）**：真实公共目录源的线上格式本任务**未联网核对（not-run）**，演示前请先确认目标源返回的就是上面这个 `{format:1, plugins:[...]}` 形状；判断方法：查缺补漏结果会带 `error` 说明解析失败，不会静默当成「没有缺口」。
   **无源/源不可达分支（必须知道怎么讲）**：不会假装「你没有缺口」——查缺补漏返回 `items: []` + 明确 `error`（fail-open）。此时把第 4 镜改成「目录不可达」演示；后续「生成工具包 → 预览 → 应用 → 回滚」**不依赖目录源**，仍可完整演示（pack 提案来自地图，不是目录）。
4. **地图：演示「能力点展开证据」必配**。v1 面板只读已保存地图：演示前在会话里让 agent 调 `stow_map_save`（参数见 §5.3），或把下面这份合法 `map.json` 放进数据根。`evidence` 里要有 `source/tools/used30d/lastUsedAt`，点能力点才有证据可讲：
~~~json
{
  "scenarios": ["dev", "content"],
  "custom": "给研发团队做内部小工具",
  "stages": [
    {
      "id": "understand",
      "title": "理解需求",
      "capabilities": [
        { "id": "read-code", "title": "读代码", "status": "have",
          "evidence": { "source": "scan", "tools": ["read"], "used30d": 2, "lastUsedAt": "2026-11-25T08:00:00.000Z" } }
      ],
      "tools": ["read", "grep"],
      "skills": ["brainstorming"]
    },
    {
      "id": "deliver",
      "title": "交付",
      "capabilities": [
        { "id": "web-search", "title": "联网搜索", "status": "missing", "evidence": { "source": "catalog" } },
        { "id": "write-doc", "title": "写文档", "status": "have",
          "evidence": { "source": "scan", "tools": ["write"], "used30d": 0, "lastUsedAt": null } },
        { "id": "notes", "title": "笔记", "status": "redundant", "evidence": { "source": "scan", "tools": [] } }
      ],
      "tools": ["write"],
      "skills": ["writing-plans"]
    }
  ]
}
~~~
   `stages[].tools/skills` 是 R-4A 可选字段，生成工具包时按 stageIds 合并去重；`evidence` 是开放对象，字段由地图制作者提供。
5. 建议录屏前先点一次「重新扫描」，避免首屏是未扫描空态。

### 1.2 分镜（0:00 – 1:00）

| 时间 | 画面 / 操作 | 旁白要点 |
|---|---|---|
| 0:00–0:08 | 侧栏面板行「归置」→ 主区「整理」页。扫描后四张卡片：插件 / 工具 / 技能 / 近 30 天未用；下方工具表（名称、owners、近 30 天用量） | 「先看家底。插件、工具、技能一目了然；用量未知就显示『未知』，绝不写成 0。」 |
| 0:08–0:16 | 切「场景」页。点「研发」「内容生产」两个 chip，自定义一句「给研发团队做内部小工具」，点「保存场景」 | 「工作流先选场景；场景只写本机状态，不调模型、不生成工作流。」 |
| 0:16–0:30 | 切「地图」页：两张阶段卡（理解需求 / 交付），能力点绿（已有）/ 黄（缺）/ 灰（冗余）。点黄色「联网搜索」 | 「地图按阶段摊开能力点。点一下能力点，证据展开：来源、工具、近 30 天用量、最后使用时间。」 |
| 0:30–0:38 | 点「查缺补漏」。结果区出现安装提案（如 dsh-web-search），带来源与说明 | 「缺的部分来自公共目录；目录不可达会报错，不会显示成『没有缺口』。」 |
| 0:38–0:47 | 点「生成工具包」（stageIds = 全部阶段）。**这一步只生成提案、不落盘**：proposals 里出现一条 `kind=pack` 提案，同时 `packs` 状态文档存入生成时的 pack（packs/ 目录仍为空）；结果区标题为「已生成能力包提案（等待预览/应用）」，显示 pack id / 工具数 / 技能数 / 阶段数。再点「预览变更」：列表出现「安装提案 + 这条 pack 提案」与稳定 hash | 「工具包先是一条可预览的提案，不是文件：阶段、工具、技能都写在提案里；生成时的内容已被保存，之后地图再改也不会影响它。预览给出稳定 hash，确认前不动任何东西。」 |
| 0:47–0:56 | 点「应用」：applied 只有 pack 提案 id（install 提案 v1 只给 warning、不安装），显示 snapshotId；**这时才在 packs/<id>.json 落盘**（先快照、先把旧包备份/台账写进快照，再写文件）。点「回滚」：本次新建的包文件被删除；若该包此前已存在，则恢复覆盖前的旧内容；四份状态恢复到应用前，重复回滚也不报错 | 「应用前先写快照、先备份旧包并记台账，然后才导出包文件；v1 不写 profile。回滚删除这次新建的包、恢复被覆盖的旧包并恢复状态，重复回滚幂等。」 |
| 0:56–1:00 | 点「生成派单草稿」→ 文本区显示「这个活只需要 A / B / C」，点「复制到剪贴板」 | 「派单草稿只是给会话的软约束，面板不会代发、不会塞进输入框。全部只读，写操作先预览、先快照、可回滚。」 |

> **文案已修正（最终修复波 F7）**：client.js 的「生成工具包」结果区标题为「已生成能力包提案（等待预览/应用）」，不再显示空的「路径：」行，并提示「应用成功后写入 packs/<id>.json」。功能链路与文案一致；演示以「预览变更」里出现的 pack 提案与「应用」后的落盘为准。

### 1.3 60 秒必须讲清的四件事（对应设计 §11 #6）

1. **我的家底**：插件 / 工具 / 技能 / 近 30 天未用 + 每个工具的归属与用量（未知 ≠ 0）。
2. **我的工作流**：场景多选 → 阶段化地图 → 能力点状态。
3. **缺什么**：安装提案来自公共目录、可解释、可失败（fail-open 明示 error）；pack 提案来自地图（不依赖目录源）。
4. **派出去的那个只带 5 个工具**：v1 是「派单草稿 + 工具包声明」（文本软约束，不实际限制工具面）；工具包先以提案形式出现在预览里，「应用」后才落盘成 `packs/<id>.json`。演示可在草稿/包的工具列表里指出前 5 个；硬限制工具面是 v-next（设计 §13），不要宣称已隔离工具。

---

## 2. 设计 §11 验收清单（8 条）

| # | 验收条（设计 §11） | 状态 | 证据 | 缺口 / 手动步骤 |
|---|---|---|---|---|
| 1 | 在装了不少于 20 个插件的真实 DSH 上：扫描 10 秒内出结果（第二次缓存后更快） | **PARTIAL** | 真实 desktop profile 只读冒烟：30 插件（19 npm / 11 patch）、88 工具、scan 冷 240ms、归因 246ms、整链 987ms，均远小于 10s（§3） | 「缓存后更快」**未实现**：v1 没有扫描结果缓存，第二次 scan 仍 ~234ms；面板靠轮询 GET state 读已落盘 scan.json，不重复扫描。真机宿主内扫描 not-run（手动步骤 §4.2-5）。见 issue 1 |
| 2 | 地图页每个能力点都能点出证据（插件、次数、时间） | **PARTIAL** | e2e 断言 map 能力点 evidence 对象持久化并可读回（scan 证据含 source / tools / used30d / lastUsedAt），client 地图页点击能力点展开 evidence（中文 label 映射）；演示前按 §1.1-4 准备带这些字段的地图 | 证据字段由地图制作者写入（schema 允许开放 evidence 对象）；「自动把 scan 事实填进 map」未实现。真机面板 not-run（§4.2-2） |
| 3 | 任一建议能生成包并预览；确认后应用成功，回滚成功 | **PASS**（自动化链路证据；真机 not-run） | e2e 走**真实入口**全链路：/gaps 产生安装提案 → /pack 生成 kind=pack 提案并把生成时的 pack 存入 `packs` 状态（packs/ 目录仍无文件）→ /preview 含该 pack 提案且同输入 hash 稳定、ids 过滤 → /apply 建快照（tag=before-apply）+ 备份既有包/写 `packs-created.json` 台账（entries: {path, existedBefore}）+ 导出 `packs/<id>.json`（内容 = 生成时存储的 pack，R-8A）→ /rollback 恢复被覆盖旧包/删除本次新建包 + store.restore 恢复状态、重复回滚幂等。e2e 6/6、全量 280/280 通过 | 真机面板/真机链路 not-run（§4.2-2/5/8）；install/skill 安装与「新会话/重启」提示留 v1.1（issue 3） |
| 4 | 包能导出成文件、人能读懂；显式勾选安装时，插件行安装成功并提示「需要新会话 / 重启」 | **PARTIAL** | 导出 ✅（apply 后落盘）：e2e 断言 `packs/<id>.json` 存在、内容与 /pack 时存入 `packs` 状态的 pack 全量深比较（id/version/stageIds/tools/skills/requirements/createdAt）、schemas.pack 合法。**格式归属**：pretty JSON（2 空格缩进 + 结尾换行）、1MB 上限与「临时文件 + rename」原子写由 lib/packs.js 的 exportPack 实现 | 安装 **v1 不做**（D7 裁决：apply 只写 pack 文件，install/skill 只 warning）；v1.1 显式勾选安装与「需要新会话 / 重启」提示 not-run（§4.2-7） |
| 5 | 每个能力点标出生效方式；「需单开会话」的插件有明确徽章和手动步骤 | **NOT-MET（v1 未实现，列入 v1.1 backlog）** | 无 | D7 map 形状没有「生效方式 / ownSession」字段，client 无徽章；属 v1 未实现范围（设计 §7/§11 要求，计划未排期，见 §2.1）。v1.1：evidence 增 appliesAt/ownSession + 面板徽章与手动步骤文案 |
| 6 | 60 秒录屏能讲清：家底 → 工作流 → 缺什么 → 派出去的那个只带 5 个工具 | **PARTIAL** | 脚本就位（本文 §1），流程与按钮均为 client.js 真实文案 | **录屏 not-run**：需在真机安装后由人录制（§4.2-6） |
| 7 | 给 3 个已有自己配置的 DSH 用户看，至少 2 人问「怎么装的」 | **NOT-RUN** | 无 | 用户测试 not-run（§4.2-6），需真人参与 |
| 8 | 全流程不依赖 rc 版本的内部语义（不调 restrict、不挂钩子、不改预设） | **PASS**（静态 + 测试证据） | e2e 与各单测只调用 lib 公开函数与路由 handler；lib 内 grep 无 restrict / agentPresets / 预设写入；写操作只落在数据根；`node --check` lib 全部模块 / client.js 通过；D11：静态测试断言仅 lib/index.js import @deepseek-ai/dsh-tools | 真机 not-run；宿主 API 兼容性以 docs/host-notes.md 的契约核对为准 |

### 2.1 设计承诺逐条裁决（修复波 F4）

以下设计承诺在 v1 **未实现**（计划未排期），统一列入 **v1.1 backlog**，不写成 pass：

| 设计承诺 | 出处 | v1 裁决 | 现状 / 说明 |
|---|---|---|---|
| 能力点「生效方式 / ownSession」徽章与手动步骤 | §11 #5、§7 | **NOT-MET（v1.1）** | map/pack 无该字段，client 无徽章（§2 表 #5） |
| 整理页「重复/冲突、上下文成本」 | §5 | **NOT-MET（v1.1）** | 整理页只有家底四卡 + 工具表 + 扫描提示（技术细节折叠）；无重复/冲突检测、无上下文成本估算 |
| 应用抽屉「逐条可启用/忽略」 | §5/§10 | **NOT-MET（v1.1）** | 预览后「应用」按 preview 全部条目执行；没有逐条开关/忽略的应用抽屉 |
| 「冗余提案 / 来源与信任等级」 | §7 | **NOT-MET（v1.1）** | proposals 只有 kind/title/effect/evidence；冗余能力点只在地图里标记，未生成提案，也没有信任等级 |
| 无 client 插件时的 HTML 报告兜底 | §13 | **NOT-MET（v1.1）** | 当前只有 Web 面板 + HTTP 路由；没有静态 HTML 报告导出 |
| 「场景 → 工作流自动生成」 | §5/§13 | **NOT-MET（v1.1）** | 场景只保存选择；地图阶段由会话 agent 调 stow_map_save 写入（确定性种子，无 AI 拆解） |

---

## 3. 真实 profile 只读冒烟（§11 #1 的近似证据）

- 方法：一次性脚本（不提交；位于 gitignore 的 .superpowers/ 下）调用 lib/host.js 的 createHostAdapter（ctx 桩，仅读 profile 文件）+ lib/attribution.js 的 attributeTools/withAttribution + lib/usage.js 的 summarizeUsage + lib/scan.js 的 scanFacts。**不启动宿主、不写 profile、不写数据根**。
- profile：C:/Users/Administrator/.dsh/profiles/desktop；数据根在冒烟前后均不存在（guizhiDataRootBefore=false / After=false），profile/package.json mtime 前后一致。
- 命令（在仓库根执行）：`node .superpowers/sdd/2026-11-26-guizhi-v1/t8-smoke.mjs`
- **可复现性（如实说明）**：该脚本是一次性工具，位于 gitignored 的 `.superpowers/sdd/`，**不随仓库分发**（输出存档同目录 `t8-smoke.out.json`）。所以上表是「当时这台机器 / 这份 profile」的读数，不是读者可一键复跑的 benchmark。复现方法：
  1) 用仓库公开函数重建最小脚本：`createHostAdapter`（ctx 桩，仅读 profile 文件，不启动宿主）→ `withAttribution` → `summarizeUsage` → `scanFacts`；**不写 profile、不写数据根、不联网**；
  2) 显式传入 profile 路径与 DSH 版本；profile 需装 ≥20 个插件；
  3) 读数随机器、插件数量与会话日志大小变化，只作量级参考；等价的自动化覆盖见 test/attribution.test.js、test/scan.test.js、test/usage.test.js。

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

结论：**扫描 < 10s 达标**（240ms 级）；「缓存后更快」不达标（无缓存，见 issue 1）；归因覆盖 38/88 属 v1 已知上限（issue 4）。注意这是「无宿主、当前会话工具面」的近似，真机宿主内 stow_scan 尚未执行（§4.2-5）。

---

## 4. not-run 清单与手动步骤

### 4.1 为什么 not-run

本会话运行在真实 DSH 内；任务约束（D5）禁止重启宿主、禁止修改真实 profile、禁止起替代服务，因此所有「安装生效后」的验证都在本任务停止，等用户执行。

### 4.2 手动步骤

1. **安装插件（用户执行）**：把 @fanyingnie/dsh-guizhi 装进 desktop profile（pnpm add file: 或复制到 profile/node_modules），并在 profile 的 cordis.patch.yml 增加一行（id: guizhi / name: @fanyingnie/dsh-guizhi）。注意：本任务未执行，也不建议直接改生产 profile；建议新开一个测试 profile。
2. **重启 DSH（用户执行）**：重启后侧栏出现「归置」面板行，主区「整理 / 场景 / 工作流」三屏可切换；slots 缺失只 console.warn，不应有 console.error。
3. **工具面（用户执行）**：新会话应出现 9 个工具 stow_scan / stow_status / stow_map_save / stow_pack_build / stow_gaps / stow_preview / stow_apply / stow_rollback / stow_draft；逐个调用一次，业务失败应返回 {ok:false,...} 文本而不是崩溃。真机注册尚未验证（Task 7 只做了宿主 defineTool 编译冒烟 9/9 allOk，不是运行注册）。
4. **路由（用户执行，只读）**：GET http://127.0.0.1:<宿主端口>/api/guizhi/state 应返回 {scan,map,proposals,selections,dispatch,dispatchSupported,warnings}；非 loopback 请求应被围栏拒绝。
5. **≥20 插件真机扫描（用户执行）**：在宿主内点「重新扫描」或调用 stow_scan，记录：插件数 / 工具数 / 技能数 / 归因数 / 每步耗时；第一次扫描应 ≤10s（本任务只读近似 240ms，但真机含会话日志用量统计会更慢），第二次是否更快（当前实现没有扫描缓存 → 预期相近，记 issue）。
6. **60 秒录屏与用户测试（用户执行）**：按 §1 录制；找 3 位已有自己 DSH 配置的用户看，记录是否有人问「怎么装的」。
7. **v1.1 安装与生效方式（未来任务）**：显式勾选安装插件行（写 profile 前预览 + 快照 + 回滚 + 「需要新会话 / 重启」提示）；能力点生效方式与「需单开会话」徽章（§11 #4/#5）。
8. **「生成工具包 → 预览 → 应用 → 回滚」真机闭环（用户执行）**：点「生成工具包」后确认 `<数据根>/packs/` 仍为空、proposals 里出现 kind=pack 提案、`<数据根>/packs.json` 里存入生成时的 pack；「预览变更」能看到该提案；「应用」后 `packs/<id>.json` 出现、`snapshots/<snapshotId>/packs-created.json` 有台账（`entries: [{path, existedBefore}]`）；「回滚」后本次新建的包文件消失、若该包此前已存在则恢复覆盖前内容、四份状态恢复，再点一次回滚不报错。
9. **一键整理（用户执行）**：工作流页点「一键整理」（页面会显示圆环进度条、百分比与当前工作项）：自动扫描 → 查缺补漏 → 生成能力包（全部阶段）→ 预览 → 自动应用 pack 提案（先快照、可回滚；v1 只导出能力包文件，安装类提案仍只作为提案）。结果区显示每步摘要、能力包 id 与快照 id（已填入回滚框）。
10. **后台派单真机（用户执行）**：工作流页空状态点「让 Agent 后台拆解」（需先在「场景」页选择并保存场景）。预期：结果区显示「已提交后台派单」与后台会话 id；状态行显示「后台执行中…（开始于 HH:MM）」；数据根 `<数据根>/dispatch.json` 出现 `state:running` 记录；GET `/api/guizhi/state` 的 `dispatch.state` 为 running；agent 在后台会话里调用 `stow_map_save` 后，地图页 3 秒轮询自动出现阶段（不需要刷新或切会话）；失败/超时/会话丢失显示原因并可重试；「查看后台会话」只在点击时打开，不自动切主界面。若宿主缺少 `sessionController`，按钮禁用并提示、POST 返回 503。连点两次只会准入一次：第二次提示「后台派单正在提交/执行中」；上一单状态读取失败时不会重复派单。

---

## 5. 关键契约（给未来维护者）

### 5.1 前缀与命名

- 插件 id：guizhi；包名：@fanyingnie/dsh-guizhi。
- 工具前缀：stow_，共 9 个（见 §4.2-3）。
- 路由前缀：/api/guizhi，root-absolute；客户端 fetch 必须 document-relative（api/guizhi/...，宿主以 <base href="./"> 部署）。
- 路由（10 条，见 [routes.js](../lib/routes.js) ROUTE_PATHS）：GET state；POST scan / scenarios / map / pack / gaps / preview / apply / rollback / draft。

### 5.2 数据根（D16 修订）

- **宿主服务优先**：`dshHomePath('guizhi')` → `profileContext.home + /guizhi`（rc.5 是否提供这些服务按 docs/host-notes.md 核对；真机落点 not-run）。
- 以上都不可用时，按 `resolveDshHome` 的 **3 级回退链**再拼 `/guizhi`（lib/host.js）：
  1. 显式 `options.home`（测试 / 嵌入方传入）；
  2. `$DSH_HOME`（纯空白视为未设）；
  3. `~/.dsh`。
- 本仓库测试与演示脚本一律显式传入 `home`，不依赖上述探测。

文件布局（1MB/文件上限，全部原子写：临时文件 + rename）：

~~~
<数据根>/scan.json          最近一次扫描（D7 scan）
<数据根>/map.json           工作流地图（D7 map，R-4A 允许 stage.tools/skills）
<数据根>/proposals.json     { items: Proposal[], generatedAt }
<数据根>/selections.json    { selected: string[], custom: string }
<数据根>/packs.json         { packs: Pack[] }（F2/R-8A：/pack 生成时存入，上限 50 条，最旧淘汰）
<数据根>/sources.json       目录源配置（可选）
<数据根>/packs/<id>.json    导出的能力包（只有 apply 会写）
<数据根>/snapshots/<id>/    状态副本 + meta.json + packs-created.json（apply 台账）+ packs-backup/（F1：被覆盖旧包的字节备份）
<数据根>/catalog/           目录缓存（index-<sha256 前16>.json）
~~~

### 5.3 契约形状（D7 + 修订）

- map = { scenarios, custom?, stages: [{ id, title, capabilities: [{ id, title, status: have|missing|redundant, evidence: object }], tools?, skills? }] }，stage id 唯一（R-4A）。
- pack = { version:1, id, title, createdAt, stageIds, rows:[], tools:[], skills:[], items:[], requirements:{appliesAt:'new-session',ownSession:false} }；id = pack- + sha256(title+stageIds) 前 8 hex（确定性）。
- Proposal = { id, kind: 'install'|'pack'|'skill', title, effect, evidence:{source, refs?} }。
- **pack 提案（R-PACK）**：`/pack`（stow_pack_build）产出 `{ id: pack.id, kind: 'pack', title: pack.title, effect: '导出能力包 <title>（N 个工具 / M 个技能）', evidence: { source: 'map', refs: stageIds } }`，upsert 进 proposals（同 id 原地替换、其余提案保留）；同时把生成时的完整 pack upsert 进 `packs` 状态（同 id 原地替换、上限 50 条、超出丢弃最旧并 warning，F2）；**不写 packs/ 文件、不写 profile**。
- **packs 状态文档（F2/R-8A）**：`{ packs: Pack[] }`，每项复用 schemas.pack 严格校验；apply 只导出这里存储的 pack，不再用当前 map 重建。
- scan = { plugins, tools[{name,description,owners[],used30d:number|null,lastUsedAt}], skills, totals{plugins,tools,skills,unusedTools}, warnings, generatedAt }；用量未知时 used30d=null 且 unusedTools 只统计已知 0。
- preview 的 hash = sha256(canonical JSON(选中 items 的 id/kind/title/effect))。

### 5.4 v1 行为裁决（写代码前先读）

- **/pack 只生成提案，不落盘**（R-PACK）：读已保存地图 → buildPack → 把生成时的 pack upsert 进 `packs` 状态、把一条 kind=pack 提案 upsert 进 proposals；同 id 原地替换（幂等，不重复追加），其余提案/pack 保留；不写 packs/、不写 profile。返回 {pack, proposal}（F2：proposals 与 packs 都先校验再写，坏文档不覆盖）。
- **apply 才写 pack 文件**；kind install/skill 只给 warning，绝不写 profile（D7）。apply 的 kind=pack 分支**从 `packs` 状态读取提案 id 对应的 pack**（R-8A，缺失 → 400 PACK_NOT_FOUND，绝不用当前 map 重建）。写盘顺序：先快照 → 对要被覆盖的旧包把旧字节备份到 `snapshots/<id>/packs-backup/` 并写台账 `packs-created.json`（`entries: [{path, existedBefore}]`）→ 再 exportPack（R-6A/R-6B：崩溃或导出失败都可恢复/回滚）。导出中途失败：删除本次新建文件、恢复已覆盖文件的备份、台账收敛为仍需回滚的条目（全部清理干净则删台账），错误带 snapshotId。
- **rollback** = 按台账把 `existedBefore:true` 的文件恢复成备份字节、`existedBefore:false` 的本次新建文件删除（缺失跳过、只动 <数据根>/packs 内路径），然后 store.restore；重复回滚幂等（恢复同字节/缺失跳过）。错误映射（F7）：快照不存在/非法 id → 404 `ROLLBACK_FAILED`；快照存在但恢复 I/O 失败 → 500 `ROLLBACK_RESTORE_FAILED`。
- **gaps 无地图 = 400 NO_MAP 且不写 proposals**（R-7A）；目录不可达 fail-open 返回 items [] + error，仍写 proposals。
- **已知接缝（v1 接受）**：再次执行「查缺补漏」会用新的安装提案整体覆盖 proposals（D7 现有语义），此前 /pack 生成的 pack 提案会随之消失；重新点一次「生成工具包」即可补回（同 id 幂等）。
- **v1 不写 profile、不改预设、不调 restrict/钩子**；不调模型 API；外部目录数据只当数据，schema 校验 + 缓存 + fail-open。
- D11：**只有 lib/index.js 可以 import @deepseek-ai/dsh-tools**；测试不得 import lib/index.js。

### 5.5 验证命令

~~~bash
node --test test/e2e.test.js     # 全链路验收（真实 /pack 提案入口 + R-6B/R-8A 三个用例）：6/6 通过
node --test test/*.test.js       # 全量：280/280 通过
node --check lib/apply.js && node --check lib/routes.js && node --check lib/host.js && node --check lib/http.js && node --check lib/index.js && node --check client.js
~~~

---

## 6. 已知缺口 / issue 列表（v1 不阻塞，交后续分诊）

1. **没有扫描缓存**：§11 #1 的「第二次缓存后更快」不满足；面板靠读 scan.json 呈现，不重复扫描。真机耗时需在宿主内复测。
2. **§11 #5 与 §2.1 的六项设计承诺未实现**：统一列入 v1.1 backlog（计划未排期，不是 v1 缺陷；逐条裁决见 §2.1）。
3. **§11 #4 安装未实现**：v1 按 D7 只导出包，安装与「新会话 / 重启」提示留 v1.1。
4. **归因覆盖 38/88**：静态归因受 200 文件 / 1MB / 仅 npm 插件限制；无法归因的工具汇总一条 warning，不虚构来源。
5. **无宿主冒烟中 skills 服务不可用**：技能数只能用文件系统旁证（10），真机需以 skills 服务为准。
6. **真机未验证项**：安装、重启、面板三屏、9 工具注册、路由挂载、≥20 插件宿主内扫描、「生成工具包→预览→应用→回滚」真机闭环、录屏、用户测试（见 §4）。
7. **（已修复，最终修复波 F7）** 面板「生成工具包」结果文案：标题改为「已生成能力包提案（等待预览/应用）」，删除空的「路径：」行，提示「应用成功后写入 packs/<id>.json」；并有静态同步测试锁住 client 文案/版本/场景表。
8. **「查缺补漏」会覆盖已有 pack 提案**：gaps 按 D7 语义整体重写 proposals，之前 /pack 生成的 pack 提案会消失（packs 状态里的包仍在，重新点「生成工具包」即可按同 id 补回提案）。演示时先讲缺口、再生成工具包。
9. **真实公共目录源格式未联网核对（not-run）**：§1.1 的 format-1 形状已按 lib/catalog.js 的 parseFormat1 与 test/fixtures/index.json 校正为 `{format:1, plugins:[...]}`；真实源需演示前确认，解析失败会 fail-open 返回明确 error，不会假装没有缺口。
