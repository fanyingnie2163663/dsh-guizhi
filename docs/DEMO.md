# 归置（Stow）· 演示脚本与 v1 验收记录

- 日期：2026-11-26（S1/S2/S3 于 2026-11-28 更新）
- 分支：v1；Task 8 BASE：7a7c905；T8.5（R-PACK 闭合 pack 提案链）在 784960b 之后提交
- 最终修复波：BASE 23c3754，F1-F7（R-6B 回滚数据丢失 / R-8A preview-apply 一致性 / DEMO format-1 / spec 承诺裁决 / 用量窗口下推 / HTTP 适配抽测 / client 文案与便宜 Minor）；内部修复记录不随仓库分发。
- S1（2026-11-28）：能力包 → 装配清单命名与诚实文案；一键整理到预览即止（不再自动应用）；/pack 空清单告警；pack 从能力点 evidence 派生工具 / 技能。
- S2（2026-11-28）：应用装配清单默认**只导出** `packs/<id>.json`；技能安装改为 **opt-in**（勾选操作区复选框才写 `$DSH_HOME/skills/stow-<id>/SKILL.md`，frontmatter 默认 `disable-model-invocation: true`；rollback 删除/恢复；快照台账 `skills-created.json` + `skills-backup/`）。新增按 pack 生成派单草稿（`stow_draft` 可选 `packId`：父→子软载荷，工具面未被硬限制）。真机检测（修复前）：写入后当前会话未刷新（32→32）；已加入 `skills.invalidateCache()` 刷新修复（待重启复验）。
- S3（2026-11-28）：实验性「受限 worker 派发」——面板「派发受限子代理」按钮（需先生成装配清单）、HTTP `POST /api/guizhi/dispatch` 与第 10 个工具 `stow_dispatch`；pack 派发在 `agent/created` 后尝试 `agent.ctx.tools.restrict({ allow })` 裁剪 worker 工具面。**实验性、尽力而为**：`run_code`、归置自身层与宿主豁免工具可能仍可见，不承诺严格 N，真机未验证。真机检测（修复前）：写入合法临时技能后当前会话 skills 数 32→32 未刷新；已加入 `skills.invalidateCache()` 刷新修复（待重启复验）。
- 相关代码：[routes.js](../lib/routes.js)、[apply.js](../lib/apply.js)、[skillpack.js](../lib/skillpack.js)、[store.js](../lib/store.js)、[http.js](../lib/http.js)、[client.js](../client.js)、[e2e.test.js](../test/e2e.test.js)
- 本文件同时是「演示脚本」与「设计文档 §11 验收」的证据记录。真机安装/重启/面板/录屏在本机为 **not-run**（禁止重启宿主、禁止改真实 profile），凡 not-run 一律不写成 pass。

状态记号：**PASS** = 自动化测试/只读冒烟已给证据；**PARTIAL** = 链路有测试证据但真机项 not-run 或验收子项未实现；**NOT-RUN** = 本任务未执行，附手动步骤。

---

## 1. 60 秒演示脚本

### 1.1 录屏前准备（一次性）

1. 真机安装（**需用户手动**，见 §4.1）：插件进 profile，重启 DSH，侧栏出现「归置」行。
2. 数据根：见 §5.2 的解析链；下文用 `<数据根>` 指代实际落点。
3. **目录源：演示「查缺补漏」必配**。写 `<数据根>/sources.json`，指向一个可访问的 format-1 目录索引；索引形如 `{ "format": 1, "plugins": [ { "name", "title", "description", "version"? } ] }`（与 lib/catalog.js 的 parseFormat1 及 [test/fixtures/index.json](../test/fixtures/index.json) 一致；根对象必须带 `plugins` 数组，不是 `entries`；`title` / `description` 可为字符串或 `{ en, zh }` 语言文案对象）：
~~~json
{ "catalog": { "url": "https://example.com/format-1-index.json" } }
~~~
   **格式核对状态（2026-11-27 更新）**：已联网核对三个真实源——`https://dshopen.org/index.json`、`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`、`https://awesome-dsh-plugin.com/index.json`：根均为 `{format:1, plugins:[...]}`，`title` / `description` 有 `{en,zh}` 本地化对象（parseFormat1 已支持）；`https://dshmarket.com/index.json` 本次核验超时，未确认。演示前仍建议先点一次「查缺补漏」；解析失败会带明确 `error`（fail-open），不会静默当成「没有缺口」。
   **无源/源不可达分支（必须知道怎么讲）**：不会假装「你没有缺口」——查缺补漏返回 `items: []` + 明确 `error`（fail-open）。此时把第 4 镜改成「目录不可达」演示；后续「生成装配清单 → 预览 → 应用 → 回滚」**不依赖目录源**，仍可完整演示（pack 提案来自地图，不是目录）。
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
   `stages[].tools/skills` 是 R-4A 可选字段，生成装配清单时按 stageIds 合并去重；缺声明时按能力点 `evidence` 派生工具 / 技能（`evidence.tools` / `tool` / `skills` / `skill`），并逐能力点写进 `rows`；`evidence` 是开放对象，字段由地图制作者提供。
5. 建议录屏前先点一次「重新扫描」，避免首屏是未扫描空态。
6. **技能目录（opt-in 分支才需要）**：apply 默认只导出 `packs/<id>.json`，不碰技能目录。只有演示「勾选安装技能」分支时才写 `$DSH_HOME/skills/stow-<id>/SKILL.md`（`$DSH_HOME` 与数据根同级，数据根通常是 `$DSH_HOME/guizhi`）；提前确认 skills 目录可写；若已有同名技能，apply 会先备份到 `snapshots/<id>/skills-backup/` 再覆盖（回滚恢复）。生成的 `SKILL.md` frontmatter 默认 `disable-model-invocation: true`（不占模型技能目录，可手改）。

7. **S3 受限 worker（加演才需要）**：先按 §1.2 点一次「生成装配清单」（「派发受限子代理」按钮在拿到最近 pack id 前禁用、提示先生成装配清单）；真机派发与工具面验收见 §4.2-11（not-run）。

### 1.2 分镜（0:00 – 1:00）

| 时间 | 画面 / 操作 | 旁白要点 |
|---|---|---|
| 0:00–0:08 | 侧栏面板行「归置」→ 主区「整理」页。扫描后四张卡片：插件 / 工具 / 技能 / 近 30 天未用；下方工具表（名称、owners、近 30 天用量） | 「先看家底。插件、工具、技能一目了然；用量未知就显示『未知』，绝不写成 0。」 |
| 0:08–0:16 | 切「场景」页。点「研发」「内容生产」两个 chip，自定义一句「给研发团队做内部小工具」，点「保存场景」 | 「工作流先选场景；场景只写本机状态，不调模型、不生成工作流。」 |
| 0:16–0:30 | 切「地图」页：两张阶段卡（理解需求 / 交付），能力点绿（已有）/ 黄（缺）/ 灰（冗余）。点黄色「联网搜索」 | 「地图按阶段摊开能力点。点一下能力点，证据展开：来源、工具、近 30 天用量、最后使用时间。」 |
| 0:30–0:38 | 点「查缺补漏」。结果区出现安装提案（如 dsh-web-search），带来源与说明 | 「缺的部分来自公共目录；目录不可达会报错，不会显示成『没有缺口』。」 |
| 0:38–0:47 | 点「生成装配清单」（stageIds = 全部阶段）。**这一步只生成提案、不落盘**：proposals 里出现一条 `kind=pack` 提案，同时 `packs` 状态文档存入生成时的 pack（packs/ 目录仍为空）；结果区标题为「已生成装配清单提案（等待预览/应用）」，显示 pack id / 工具数 / 技能数 / 阶段数，空清单会带警告。再点「预览变更」：列表出现「安装提案 + 这条 pack 提案」与稳定 hash | 「装配清单先是一条可预览的提案，不是文件：阶段、工具、技能都写在提案里；生成时的内容已被保存，之后地图再改也不会影响它。预览给出稳定 hash，确认前不动任何东西。应用时默认只导出 packs/<id>.json；勾选「应用时安装工作流技能」才会写 SKILL.md；v1 不安装插件、不改 profile。」 |
| 0:47–0:56 | 点「应用」（先不勾选技能复选框）：applied 只有 pack 提案 id（install 提案 v1 只给 warning、不安装），显示 snapshotId；**这时在 packs/<id>.json 落盘，技能目录不变**。再勾选「应用时安装工作流技能」，重新生成装配清单 → 预览 → 应用：这次额外写入 `$DSH_HOME/skills/stow-<id>/SKILL.md`（frontmatter 默认 `disable-model-invocation: true`；先快照、先写会被覆盖的旧包 / 旧技能的备份与台账）。点「回滚」：本次新建的包与技能文件被删除；若此前已存在，则恢复覆盖前的旧内容；四份状态恢复到应用前，重复回滚也不报错 | 「应用默认只导出装配清单；只有勾选安装技能才会写技能目录，而且默认不进入模型技能目录（disable-model-invocation: true），可手改。技能是一份工作流说明书（阶段 / 能力点 / 建议工具与技能 / 验收清单）；真机探针：当前会话技能列表未刷新（32→32），需要新会话 / 重启后才可能可见（未完全验证）。回滚会同时恢复包和技能。v1 不写 profile；S3 的受限 worker 会实验性尝试工具面 restrict（尽力而为、不保证生效）。」 |
| 0:56–1:00 | 点「生成派单草稿」：若刚生成过装配清单，面板会把最近一次 pack id 传给 /draft，文本区显示父→子结构化软载荷（阶段 / 能力点、建议工具 / 技能、执行步骤、验收清单，含固定句「只使用上述工具/技能；这是软约束，工具面未被硬限制。」）；未生成过装配清单时仍是旧的扫描草稿。点「复制到剪贴板」 | 「按装配清单派单只是给会话的软约束：不删工具 schema、不省工具面 token，面板不会代发、不会塞进输入框。全部只读，写操作先预览、先快照、可回滚。」 |

> **文案已同步（S1/S2/S3）**：client.js 的「生成装配清单」结果区标题为「已生成装配清单提案（等待预览/应用）」，提示「应用时默认只导出 packs/<id>.json；勾选「应用时安装工作流技能」时会写入 $DSH_HOME/skills/stow-<id>/SKILL.md（frontmatter 默认 disable-model-invocation: true，不进模型技能目录；可回滚）」；真机探针：写入 SKILL.md 后当前会话的技能列表没有刷新（32→32），需要新会话 / 重启后才可能可见（未完全验证）；「派发受限子代理」结果卡展示 worker 会话、toolFaceApplied、请求工具数与 warnings，并明确实验性、尽力而为（run_code 与部分宿主豁免工具可能仍可见；真机未验证）；工作流操作区有默认不勾选的「应用时安装工作流技能（写入 $DSH_HOME/skills，默认不装，可回滚）」复选框，onApply 的 body 带 `installSkill`；「应用」结果卡在「已应用 N 条」与 snapshotId 之后列出 payload.skills：未勾选且为空时提示「本次只导出装配清单，未安装技能（勾选「应用时安装工作流技能」可安装）」、勾选但为空时提示「本次未安装技能（清单为空或技能目录不可用，见警告）」；「生成派单草稿」会带上最近一次 pack id，draft 卡提示「父→子软约束、工具面未被硬限制（不删工具 schema、不省工具面 token）」；「一键整理」结果卡仍是「到预览即止」，提示「应用时默认只导出，勾选安装技能才会写技能目录」。空清单会渲染 warnings；全文不出现「应用即安装」「自动应用」等旧措辞。

### 1.2.1 S3 加演：派发受限 worker（可选，约 10 秒）

1. 前置：按 §1.2 的 0:38–0:47 生成过一次装配清单（结果区显示 pack id）；「派发受限子代理」按钮此时才可用，否则禁用并提示先生成装配清单。
2. 点「派发受限子代理」：调用 `POST /api/guizhi/dispatch` body `{ kind: 'pack', packId: <最近 pack id> }`（与会话内 `stow_dispatch` 同一实现）。
3. 看结果卡：worker 会话 id、`toolFaceApplied`（true/false）、请求限制工具数、warnings；卡片会写明「实验性、尽力而为：run_code 与部分宿主豁免工具可能仍可见，真机未验证」。
4. 解释口径：`toolFaceApplied: true` 只说明这次 restrict 被宿主接受，不等于严格 N 个工具；`false` 时是软派单继续。真机工具面验收见 §4.2-11（not-run）。

### 1.3 60 秒必须讲清的四件事（对应设计 §11 #6）

1. **我的家底**：插件 / 工具 / 技能 / 近 30 天未用 + 每个工具的归属与用量（未知 ≠ 0）。
2. **我的工作流**：场景多选 → 阶段化地图 → 能力点状态。
3. **缺什么**：安装提案来自公共目录、可解释、可失败（fail-open 明示 error）；pack 提案来自地图（不依赖目录源）。
4. **建议工具清单（示例指前 5 个）**：普通链路只给建议、不限制工具面——派单草稿是文本（按 pack 时是父→子结构化软载荷）、装配清单是 JSON + 可选工作流技能（软约束）；装配清单先以提案形式出现在预览里，「应用」后默认只落盘成 `packs/<id>.json`，勾选安装技能才额外写 `SKILL.md`（技能是工作流说明书：阶段 / 能力点 / 建议工具与技能 / 验收清单；frontmatter 默认 `disable-model-invocation: true`；真机探针：当前会话技能列表未刷新（32→32），需要新会话 / 重启后才可能可见，未完全验证）。演示可在草稿 / 清单的工具列表里指出前 5 个；S3 的「派发受限子代理」会实验性尝试 restrict（尽力而为：不保证隐藏 run_code / 自身层 / 宿主豁免工具，不承诺严格 N，真机 not-run），不要宣称工具面已被隔离；也**不要宣称草稿省了工具面 token**（它不删工具 schema）。

---

## 2. 设计 §11 验收清单（8 条）

| # | 验收条（设计 §11） | 状态 | 证据 | 缺口 / 手动步骤 |
|---|---|---|---|---|
| 1 | 在装了不少于 20 个插件的真实 DSH 上：扫描 10 秒内出结果（第二次缓存后更快） | **PARTIAL** | 真实 desktop profile 只读冒烟：30 插件（19 npm / 11 patch）、88 工具、scan 冷 240ms、归因 246ms、整链 987ms，均远小于 10s（§3） | 「缓存后更快」**未实现**：v1 没有扫描结果缓存，第二次 scan 仍 ~234ms；面板靠轮询 GET state 读已落盘 scan.json，不重复扫描。真机宿主内扫描 not-run（手动步骤 §4.2-5）。见 issue 1 |
| 2 | 地图页每个能力点都能点出证据（插件、次数、时间） | **PARTIAL** | e2e 断言 map 能力点 evidence 对象持久化并可读回（scan 证据含 source / tools / used30d / lastUsedAt），client 地图页点击能力点展开 evidence（中文 label 映射）；演示前按 §1.1-4 准备带这些字段的地图 | 证据字段由地图制作者写入（schema 允许开放 evidence 对象）；「自动把 scan 事实填进 map」未实现。真机面板 not-run（§4.2-2） |
| 3 | 任一建议能生成包并预览；确认后应用成功，回滚成功 | **PASS**（自动化链路证据；真机 not-run） | e2e 走**真实入口**全链路：/gaps 产生安装提案 → /pack 生成 kind=pack 提案并把生成时的 pack 存入 `packs` 状态（packs/ 目录仍无文件）→ /preview 含该 pack 提案且同输入 hash 稳定、ids 过滤 → /apply 建快照（tag=before-apply）+ 备份既有包/写 `packs-created.json` 台账（entries: {path, existedBefore}）+ 导出 `packs/<id>.json`（内容 = 生成时存储的 pack，R-8A），**默认不写技能（响应 skills=[]）**；opt-in 用例再以 `installSkill:true` 应用，把非空 pack 编译安装为 `$DSH_HOME/skills/stow-<id>/SKILL.md` 并写 `skills-created.json` 台账（被覆盖旧技能备份在快照 `skills-backup/<name>/`）→ /rollback 恢复被覆盖旧包与旧技能/删除本次新建包与技能 + store.restore 恢复状态、重复回滚幂等。e2e 8/8、全量 465/465 通过 | 真机面板/真机链路 not-run（§4.2-2/5/8）；**技能新会话可见性 not-run**（§4.2-8）；install 类提案（插件行安装）与「新会话/重启」提示留 v1.1（issue 3） |
| 4 | 包能导出成文件、人能读懂；显式勾选安装时，插件行安装成功并提示「需要新会话 / 重启」 | **PARTIAL** | 导出 ✅（apply 后落盘）：e2e 断言 `packs/<id>.json` 存在、内容与 /pack 时存入 `packs` 状态的 pack 全量深比较（id/version/stageIds/tools/skills/requirements/createdAt）、schemas.pack 合法。**S2 技能产物（opt-in，自动化 ✅）**：默认 apply 不安装技能（响应 skills=[]、技能目录无文件）；`installSkill:true` 时才把非空 pack 编译成确定性 `SKILL.md`（工作流阶段 / 能力点、建议工具与技能、执行步骤、验收清单；frontmatter 默认 `disable-model-invocation: true`），写入 `$DSH_HOME/skills/stow-<id>/SKILL.md`；台账 + 备份 + 回滚/重复回滚有测试覆盖（skillpack/apply/e2e） | 插件行安装 **v1 不做**（D7 裁决：kind=install 只 warning）；v1.1 显式勾选插件安装与「需要新会话 / 重启」提示 not-run（§4.2-7）；**技能新会话可见性 not-run**（§4.2-8） |
| 5 | 每个能力点标出生效方式；「需单开会话」的插件有明确徽章和手动步骤 | **NOT-MET（v1 未实现，列入 v1.1 backlog）** | 无 | D7 map 形状没有「生效方式 / ownSession」字段，client 无徽章；属 v1 未实现范围（设计 §7/§11 要求，计划未排期，见 §2.1）。v1.1：evidence 增 appliesAt/ownSession + 面板徽章与手动步骤文案；**工具面硬限制同样不承诺**（S3 的 pack 派发仅实验性尝试 restrict、尽力而为、不承诺严格 N；严格限制属 v-next） |
| 6 | 60 秒录屏能讲清：家底 → 工作流 → 缺什么 → 建议工具清单（示例指前 5 个；普通派单只给建议，S3 受限 worker 为实验性 restrict、不承诺严格 N） | **PARTIAL** | 脚本就位（本文 §1），流程与按钮均为 client.js 真实文案（含默认只导出 / 勾选安装技能 / 按 pack 派单草稿）；讲解口径见 §1.3-4 | **录屏 not-run**：需在真机安装后由人录制（§4.2-6） |
| 7 | 给 3 个已有自己配置的 DSH 用户看，至少 2 人问「怎么装的」 | **NOT-RUN** | 无 | 用户测试 not-run（§4.2-6），需真人参与 |
| 8 | 全流程不依赖 rc 版本的内部语义（不调 restrict、不挂钩子、不改预设） | **PARTIAL**（主链路 PASS；S3 受限 worker 为实验性，真机 not-run） | 地图 / 装配清单 / 技能 / 回滚主链路只调用 lib 公开函数与路由 handler，lib 内无 agentPresets / 预设写入；写操作只落在数据根；`node --check` lib 全部模块 / client.js 通过；D11：静态测试断言仅 lib/index.js import @deepseek-ai/dsh-tools。**S3 例外**：pack 派发会注册 `agent/created` / `agent/disposed` 生命周期钩子并实验性调用 `agent.ctx.tools.restrict`（宿主不提供即降级为软约束 + warning） | 真机 not-run；受限 worker 工具面真机验收见 §4.2-11；宿主 API 兼容性以 docs/host-notes.md 的契约核对为准 |

### 2.1 设计承诺逐条裁决（修复波 F4）

以下设计承诺在 v1 **未实现**（计划未排期），统一列入 **v1.1 backlog**，不写成 pass：

| 设计承诺 | 出处 | v1 裁决 | 现状 / 说明 |
|---|---|---|---|
| 能力点「生效方式 / ownSession」徽章与手动步骤 | §11 #5、§7 | **NOT-MET（v1.1）** | map/pack 无该字段，client 无徽章（§2 表 #5） |
| 整理页「重复/冲突、上下文成本」 | §5 | **NOT-MET（v1.1）** | 整理页只有家底四卡 + 工具表 + 扫描提示（技术细节折叠）；无重复/冲突检测、无上下文成本估算 |
| 应用抽屉「逐条可启用/忽略」 | §5/§10 | **NOT-MET（v1.1）** | 预览后「应用」按 preview 全部条目执行；没有逐条开关/忽略的应用抽屉 |
| 「冗余提案 / 来源与信任等级」 | §7 | **NOT-MET（v1.1，精简建议已先行）** | proposals 仍只有 kind/title/effect/evidence，冗余能力点仍未生成提案、没有信任等级；但地图能力点已可带 `capability.suggestion`，`GET state.advice` 会为冗余能力点派生「精简建议」（地图未写时按证据与扫描用量自动归纳，只建议不执行） |
| 无 client 插件时的 HTML 报告兜底 | §13 | **NOT-MET（v1.1）** | 当前只有 Web 面板 + HTTP 路由；没有静态 HTML 报告导出 |
| 「场景 → 工作流自动生成」 | §5/§13 | **NOT-MET（v1.1）** | 场景只保存选择；地图阶段由会话 agent 调 stow_map_save 写入（确定性种子，无 AI 拆解） |
| 工具面硬限制（restrict / 只启用装配清单内工具） | §13 | **PARTIAL（S3 实验性，真机 not-run）** | S3 起 pack 派发会实验性尝试 restrict，但只对宿主 `restrictableNames` 内工具生效；`run_code`、归置自身层、宿主豁免工具无法隐藏，不承诺严格 N，响应 `toolFaceApplied` 只说明 restrict 是否被调用。严格工具面硬限制仍属 v-next（preset enforcer 等未实现） |

---

## 3. 真实 profile 只读冒烟（§11 #1 的近似证据）

- 方法：一次性脚本（不提交；位于本地 gitignored 的内部工作目录）调用 lib/host.js 的 createHostAdapter（ctx 桩，仅读 profile 文件）+ lib/attribution.js 的 attributeTools/withAttribution + lib/usage.js 的 summarizeUsage + lib/scan.js 的 scanFacts。**不启动宿主、不写 profile、不写数据根**。
- profile：`~/.dsh/profiles/desktop`；数据根在冒烟前后均不存在（guizhiDataRootBefore=false / After=false），profile/package.json mtime 前后一致。
- 命令（在仓库根执行）：`node <内部工作目录>/t8-smoke.mjs`
- **可复现性（如实说明）**：该脚本是一次性工具，位于本地 gitignored 的内部工作目录，**不随仓库分发**（输出存档同目录 `t8-smoke.out.json`）。所以上表是「当时这台机器 / 这份 profile」的读数，不是读者可一键复跑的 benchmark。复现方法：
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
3. **工具面（用户执行）**：新会话应出现 10 个 stow_* 工具：stow_scan / stow_status / stow_map_save / stow_pack_build / stow_gaps / stow_preview / stow_apply / stow_rollback / stow_draft / stow_dispatch；逐个调用一次，业务失败应返回 {ok:false,...} 文本而不是崩溃。真机注册尚未验证（自动化只覆盖宿主 defineTool 编译，不是运行注册）。
4. **路由（用户执行，只读）**：GET http://127.0.0.1:<宿主端口>/api/guizhi/state 应返回 {scan,map,proposals,selections,sources,advice,dispatch,dispatchSupported,warnings}；advice 是派生的精简建议视图（不落盘），非 loopback 请求应被围栏拒绝。
5. **≥20 插件真机扫描（用户执行）**：在宿主内点「重新扫描」或调用 stow_scan，记录：插件数 / 工具数 / 技能数 / 归因数 / 每步耗时；第一次扫描应 ≤10s（本任务只读近似 240ms，但真机含会话日志用量统计会更慢），第二次是否更快（当前实现没有扫描缓存 → 预期相近，记 issue）。
6. **60 秒录屏与用户测试（用户执行）**：按 §1 录制；找 3 位已有自己 DSH 配置的用户看，记录是否有人问「怎么装的」。
7. **v1.1 插件行安装与生效方式（未来任务）**：显式勾选安装插件行（写 profile 前预览 + 快照 + 回滚 + 「需要新会话 / 重启」提示）；能力点生效方式与「需单开会话」徽章（§11 #4/#5）。（工作流技能安装 S2 已实现，但改为 opt-in，见 §4.2-8；真机检测（修复前）：当前会话未刷新（32→32）；已加入 `skills.invalidateCache()` 刷新修复（待重启复验）。）
8. **「生成装配清单 → 预览 → 应用 → 回滚」真机闭环（用户执行）**：点「生成装配清单」后确认 `<数据根>/packs/` 仍为空、proposals 里出现 kind=pack 提案、`<数据根>/packs.json` 里存入生成时的 pack，空清单（无工具无技能）时结果区应带警告；「预览变更」能看到该提案（effect 应含「应用时可选择安装工作流技能 stow-…（默认不安装）」）。**先不勾选**「应用时安装工作流技能」点「应用」：`packs/<id>.json` 出现、`snapshots/<snapshotId>/packs-created.json` 有台账（`entries: [{path, existedBefore}]`），而 `$DSH_HOME/skills/` 下不应出现 `stow-<id>`，结果卡提示「本次只导出装配清单，未安装技能（勾选「应用时安装工作流技能」可安装）」；「回滚」后包文件恢复、状态恢复，再点一次回滚不报错。**再演示 opt-in 分支**：勾选复选框 → 重新生成 / 预览 / 应用后 `$DSH_HOME/skills/stow-<id>/SKILL.md` 出现（apply 结果卡「已安装工作流技能」列出 `stow-<id>`）、`snapshots/<snapshotId>/skills-created.json` 有技能台账，frontmatter 应带 `disable-model-invocation: true`；若该技能此前已有 SKILL.md，`skills-backup/<name>/SKILL.md` 存旧字节；「回滚」后包与技能文件一起恢复（新建的删除、覆盖的还原）、四份状态恢复。**技能新会话可见性（not-run）**：真机探针已确认写入后当前会话 skills 数 32→32 未刷新；新会话 / 重启后是否可见尚未验证（本文件不宣称已可见）。
9. **一键整理（用户执行）**：工作流页点「一键整理」（页面会显示圆环进度条、百分比与当前工作项）：自动扫描 → 查缺补漏 → 生成装配清单（全部阶段）→ 预览，**到预览即止：不替用户应用、不写 `packs/` 文件、也不安装技能**。结果区标题为「一键整理完成（已到预览，未写入文件）」，显示每步摘要、预览条数与 hash、已建快照 snapshotId（已填入回滚框）、警告（空清单时 pack 步骤标黄），并提示「应用时默认只导出，勾选安装技能才会写技能目录」。确认后自己点「应用」才会落盘（默认只导出；勾选安装技能才写技能目录，先快照、可回滚；install 类提案仍只作为提案、v1 不安装）。
10. **后台派单真机（用户执行）**：工作流页空状态点「让 Agent 后台拆解」（需先在「场景」页选择并保存场景）。预期：结果区显示「已提交后台派单」与后台会话 id；状态行显示「后台执行中…（开始于 HH:MM）」；数据根 `<数据根>/dispatch.json` 出现 `state:running` 记录；GET `/api/guizhi/state` 的 `dispatch.state` 为 running；agent 在后台会话里调用 `stow_map_save` 后，地图页 3 秒轮询自动出现阶段（不需要刷新或切会话）；失败/超时/会话丢失显示原因并可重试；「查看后台会话」只在点击时打开，不自动切主界面。若宿主缺少 `sessionController`，按钮禁用并提示、POST 返回 503。连点两次只会准入一次：第二次提示「后台派单正在提交/执行中」；上一单状态读取失败时不会重复派单。
11. **受限 worker 工具面真机（用户执行，S3 实验性）**：先生成一次装配清单（「派发受限子代理」按钮才可用），点「派发受限子代理」；记录结果卡上的 worker 会话 id、`toolFaceApplied`、`toolFace.requested` 与 warnings。预期降级：缺 `sessionController` / `sessionQuery` 时按钮禁用、POST 返回 503；宿主不支持工具面准备时 `toolFaceApplied: false` + warning（软派单继续）；宿主未采用预生成会话 id 时工具面不生效 + warning。**验收不能只看响应**：打开 worker 会话（或让 worker 汇报可见工具），检查清单外工具（尤其 `run_code`、归置自身工具、宿主豁免工具）是否仍可见、worker 是否遵守软约束；本项 not-run，结果如实记录，不写成 pass。

---

## 5. 关键契约（给未来维护者）

### 5.1 前缀与命名

- 插件 id：guizhi；包名：@fanyingnie/dsh-guizhi。
- 工具前缀：stow_，共 10 个（含 stow_dispatch；见 §4.2-3）。
- 路由前缀：/api/guizhi，root-absolute；客户端 fetch 必须 document-relative（api/guizhi/...，宿主以 <base href="./"> 部署）。
- 路由（13 条，见 [routes.js](../lib/routes.js) ROUTE_PATHS）：GET state；POST scan / scenarios / map / pack / gaps / preview / apply / rollback / draft / dispatch / sources / pipeline；另有 GET pipeline/status（loopback 围栏）。

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
<数据根>/packs/<id>.json    导出的装配清单（只有 apply 会写）
<数据根>/snapshots/<id>/    状态副本 + meta.json + packs-created.json / skills-created.json（apply 台账）+ packs-backup/ / skills-backup/（被覆盖旧包 / 旧技能的字节备份）
<数据根>/catalog/           目录缓存（index-<sha256 前16>.json）
$DSH_HOME/skills/stow-<id>/SKILL.md   勾选安装技能时 apply 写入（opt-in；frontmatter 默认 disable-model-invocation: true；rollback 删除或恢复；真机检测（修复前）：当前会话技能列表未刷新（32→32）；已加入 `skills.invalidateCache()` 刷新修复（待重启复验））
~~~

### 5.3 契约形状（D7 + 修订）

- map = { scenarios, custom?, stages: [{ id, title, capabilities: [{ id, title, status: have|missing|redundant, evidence: object, suggestion?: string }], tools?, skills? }] }，stage id 唯一（R-4A）；`suggestion` 是可选精简建议（v1.1 先行项）。
- pack = { version:1, id, title, createdAt, stageIds, rows:[], tools:[], skills:[], items:[], requirements:{appliesAt:'new-session',ownSession:false} }；id = pack- + sha256(title+stageIds) 前 8 hex（确定性）。
- Proposal = { id, kind: 'install'|'pack'|'skill', title, effect, evidence:{source, refs?} }。
- **装配清单提案（pack 提案，R-PACK）**：`/pack`（stow_pack_build）产出 `{ id: pack.id, kind: 'pack', title: pack.title, effect: '导出装配清单 <title>（N 个工具 / M 个技能）；应用时可选择安装工作流技能 stow-<pack.id>（默认不安装）', evidence: { source: 'map', refs: stageIds } }`（空清单时 effect 为「…；清单为空，应用时跳过技能安装」），upsert 进 proposals（同 id 原地替换、其余提案保留）；同时把生成时的完整 pack upsert 进 `packs` 状态（同 id 原地替换、上限 50 条、超出丢弃最旧并 warning，F2）；**不写 packs/ 文件、不写技能、不写 profile**。清单 tools/skills 来自 stage 声明 + 能力点 evidence 派生（S1）；空清单时响应带 `warnings`（「无工具无技能，未生成可应用内容」），仍可预览、不伪装成可应用内容。
- **packs 状态文档（F2/R-8A）**：`{ packs: Pack[] }`，每项复用 schemas.pack 严格校验；apply 只按这里存储的 pack 导出 JSON 与编译技能，不再用当前 map 重建。
- **派单草稿（pack-aware，S2）**：POST /draft body `{ kind: 'dispatch', packId? }`；无 packId = 旧扫描草稿；有 packId 从 store('packs') 取包生成父→子结构化软载荷（标题、阶段 / 能力点、建议工具 / 技能、执行步骤、验收清单 + 固定句「只使用上述工具/技能；这是软约束，工具面未被硬限制。」）；packId 非法 / 不存在返回 400。
- **受限 worker 派发（S3 实验性）**：POST /dispatch body `{ kind: 'map' | 'pack', packId? }`。`kind='map'` = 旧地图拆解（单飞、可复用会话）；`kind='pack'` 必须带 `packId`，从 store('packs') 读包 → `buildPackWorkerPrompt(pack)` + allowlist → 预生成 `session-<uuid>` → `prepareWorkerToolFace(sessionId, allowTools)` → `createDispatchSession({ sessionId })` → `promptDispatchSession`。响应 `{ ok, dispatch: { kind: 'pack', sessionId, startedAt, state: 'running' }, toolFaceApplied, toolFace: { applied, prepared, requested }, warnings }`；`toolFaceApplied` 只在「已 prepare 且宿主采用预生成 id」时为 true。缺 `sessionController` / `sessionQuery` → 503；create/prompt 失败 → 502 + `dispatch.json` 写 `state=failed`；已有 running → 409；packId 非法 / 不存在 → 400。
- scan = { plugins, tools[{name,description,owners[],used30d:number|null,lastUsedAt}], skills, totals{plugins,tools,skills,unusedTools}, warnings, generatedAt }；用量未知时 used30d=null 且 unusedTools 只统计已知 0。
- preview 的 hash = sha256(canonical JSON(选中 items 的 id/kind/title/effect))。
- advice = { items: [{ stageId, capabilityId, title, text, hint, source: 'map'|'derived' }] }：GET state 的派生视图，不落盘；`capability.suggestion` 优先，否则只为 redundant 能力点按 evidence + scan 自动归纳（用量未知不写 0，0 次不代表无用）。

### 5.4 v1 行为裁决（写代码前先读）

- **/pack 只生成提案，不落盘**（R-PACK）：读已保存地图 → buildPack → 把生成时的 pack upsert 进 `packs` 状态、把一条 kind=pack 提案 upsert 进 proposals；同 id 原地替换（幂等，不重复追加），其余提案/pack 保留；不写 packs/、不写 profile。返回 {pack, proposal}（F2：proposals 与 packs 都先校验再写，坏文档不覆盖）。
- **apply 默认只导出 pack 文件；技能安装是 opt-in（S2）**：kind install/skill 提案只给 warning、绝不写 profile（D7）。apply 的 kind=pack 分支**从 `packs` 状态读取提案 id 对应的 pack**（R-8A，缺失 → 400 PACK_NOT_FOUND，绝不用当前 map 重建），默认只 exportPack（响应 `skills: []`）；只有 HTTP body `installSkill === true`（路由把 `skillsHome` 传给 apply）时才把非空 pack 编译为 `$DSH_HOME/skills/stow-<id>/SKILL.md`：`skillsHome = dirname(数据根)/skills`，写入前校验 skills 根目录类型、目标路径与名字（kebab-case），空 pack 跳过并给可读 warning；`installSkill` 非布尔 → 400 `INSTALL_SKILL_INVALID`；技能根不可用 / 写失败仍是 200 + warning（装配清单已导出，不把已完成的导出伪装成失败）。写盘顺序：先快照 → 对要被覆盖的旧包 / 旧技能把旧字节备份到 `snapshots/<id>/packs-backup/` / `skills-backup/<name>/` 并写台账 `packs-created.json` / `skills-created.json` → 再 exportPack 与写 SKILL.md（R-6A/R-6B/S2：崩溃或写失败都可恢复/回滚）。中途失败：删除本次新建文件、恢复已覆盖文件的备份、台账收敛为仍需回滚的条目（全部清理干净则删台账），错误带 snapshotId。
- **一键整理只到预览**（pipeline，S1）：首写前先 `store.snapshot('before-pipeline')`（在任何状态写之前）；成功响应 `{ steps: [scan, gaps, pack, preview], scan, gaps, pack, preview: { hash, itemCount }, snapshotId, warnings }`——**没有 apply 字段、不写 `packs/` 文件**；空清单时 pack 步骤 `status: 'warn'` 并追加 warning；快照之后任一步失败会带 snapshotId 返回，供回滚。
- **rollback（S2）** = 按台账把 `existedBefore:true` 的文件恢复成备份字节、`existedBefore:false` 的本次新建文件删除（缺失跳过）；包路径限定 `<数据根>/packs`，技能路径限定 `$DSH_HOME/skills` 下的 `<name>/SKILL.md`（台账路径必须与 name 对得上，防止被篡改的台账指向别处）。顺序：先恢复技能 → 再恢复包文件 → 最后 store.restore；重复回滚幂等。旧快照没有 `skills-created.json` 视为未装技能、只回滚包；带技能台账但调用方没给 skillsHome 会明确报错，不假装已回滚。错误映射（F7）：快照不存在/非法 id → 404 `ROLLBACK_FAILED`；快照存在但恢复 I/O 失败 → 500 `ROLLBACK_RESTORE_FAILED`。
- **gaps 无地图 = 400 NO_MAP 且不写 proposals**（R-7A）；目录不可达 fail-open 返回 items [] + error，仍写 proposals。
- **已知接缝（v1 接受）**：再次执行「查缺补漏」时，目录来源的安装提案会整体替换旧的目录提案；/pack 生成的 pack 提案会保留（S1 起 gaps 改为合并）。重新点「生成装配清单」仍可幂等补回（同 id 原地替换）。
- **精简建议只建议不执行**（v1.1 先行）：GET state 附带 advice（纯视图，不写状态）；地图里 `capability.suggestion` 优先，否则冗余能力点按证据与扫描用量自动归纳；不自动停用/卸载/安装任何东西，也不生成可应用提案（留给 v1.1）。
- **v1 不写 profile、不改预设**；普通链路不调 restrict / 不挂 agent 钩子。**S3 例外（实验性）**：仅 `kind='pack'` 派发会注册 `agent/created` / `agent/disposed` 钩子并尝试 `agent.ctx.tools.restrict({ allow })`，宿主不支持即降级为软约束 + warning，真机 not-run；写盘只落在数据根与 `$DSH_HOME/skills/stow-*`；不调模型 API；外部目录数据只当数据，schema 校验 + 缓存 + fail-open。
- D11：**只有 lib/index.js 可以 import @deepseek-ai/dsh-tools**；测试不得 import lib/index.js。

### 5.5 验证命令

~~~bash
node --test test/e2e.test.js     # 全链路验收（真实 /pack 提案入口 + R-6B/R-8A + S2 默认只导出 / opt-in 技能安装 / 回滚）：8/8 通过
node --test test/*.test.js       # 全量：465/465 通过
node --check lib/apply.js && node --check lib/routes.js && node --check lib/host.js && node --check lib/http.js && node --check lib/index.js && node --check client.js
~~~
11. **（S3 实验性）受限 worker 工具面真机 not-run**：`agent/created` → `agent.ctx.tools.restrict({ allow })` 契约、`restrictableNames` 可见性、宿主是否采用预生成会话 id 均未在真机验证；`run_code` / 归置自身层 / 宿主豁免工具可能仍可见，不承诺严格 N。验收看 worker 实际工具列表（§4.2-11），不看响应字段。

---

## 6. 已知缺口 / issue 列表（v1 不阻塞，交后续分诊）

1. **没有扫描缓存**：§11 #1 的「第二次缓存后更快」不满足；面板靠读 scan.json 呈现，不重复扫描。真机耗时需在宿主内复测。
2. **§11 #5 与 §2.1 的设计承诺多数未实现**：除工具面硬限制（S3 为实验性 PARTIAL）外统一列入 v1.1 backlog（计划未排期，不是 v1 缺陷；逐条裁决见 §2.1）。
3. **§11 #4 插件行安装未实现**：v1 按 D7 不安装插件、不写 profile，插件行安装与「新会话 / 重启」提示留 v1.1。工作流技能安装已由 S2 实现，但改为 **opt-in**（默认只导出，勾选才装；§2 #3/#4），且**真机检测（修复前）：当前会话未刷新（32→32），已加入 `skills.invalidateCache()` 刷新修复（待重启复验）**。
4. **归因覆盖 38/88**：静态归因受 200 文件 / 1MB / 仅 npm 插件限制；无法归因的工具汇总一条 warning，不虚构来源。
5. **无宿主冒烟中 skills 服务不可用**：技能数只能用文件系统旁证（10），真机需以 skills 服务为准。
6. **真机未验证项**：安装、重启、面板三屏、10 工具注册、路由挂载、≥20 插件宿主内扫描、「生成装配清单→预览→应用→回滚」真机闭环（默认只导出 + opt-in 安装两条分支）、**受限 worker 工具面（`toolFaceApplied` 只说明 restrict 被调用）**、**技能新会话可见性（refresh 修复待重启复验）**、录屏、用户测试（见 §4；受限 worker 手动步骤 §4.2-11）。
7. **（S1/S2/S3 均已更新文案）** 面板「生成装配清单」结果文案：标题为「已生成装配清单提案（等待预览/应用）」，删除空的「路径：」行；S3 起提示「应用时默认只导出 packs/<id>.json；勾选「应用时安装工作流技能」时才写 $DSH_HOME/skills/stow-<id>/SKILL.md（frontmatter 默认 disable-model-invocation: true，不进模型技能目录；可回滚）」。工作流操作区新增默认不勾选的安装复选框；「应用」结果卡空 skills 分两种提示（未勾选 / 勾选但为空）；「生成派单草稿」带最近 pack id，draft 卡提示父→子软约束。pack 结果卡渲染空清单 warnings；一键整理结果卡只展示预览条数 / hash / 快照 id，仍是到预览即止。S3 新增「派发受限子代理」结果卡（worker 会话 / toolFaceApplied / warnings + 实验性限制说明）与技能探针文案；静态同步测试锁住 10 工具、dispatch pack body、探针结论与禁令措辞。
8. **（S1 已修复）「查缺补漏」不再覆盖 pack 提案**：gaps 改为合并——目录来源的安装提案替换旧的目录提案，/pack 生成的 pack 提案保留；不再需要演示时反复补回提案。
9. **真实公共目录源格式已核验三个源（2026-11-27）**：dshopen / jsDelivr / awesome 源站均为 `{format:1, plugins:[...]}`，`title` / `description` 为 `{en,zh}` 本地化对象（parseFormat1 已支持，见 test/catalog.test.js 本地化用例）；`dshmarket.com/index.json` 本次超时未确认。解析失败仍 fail-open 返回明确 error，不会假装没有缺口。
10. **（S2 已实现 opt-in）技能安装**：apply 默认只导出 `packs/<id>.json`；只有 `installSkill:true` 才把非空 pack 编译为确定性 SKILL.md（lib/skillpack.js：阶段 / 能力点、建议工具与技能、执行步骤、验收清单；frontmatter 默认 `disable-model-invocation: true`），安装到 `$DSH_HOME/skills/stow-<id>/SKILL.md`；台账 `skills-created.json` + 备份 `skills-backup/`，rollback 删除/恢复；client「应用」结果卡展示 payload.skills（未勾选为空 → 提示本次只导出；勾选但为空 → 提示清单为空或技能目录不可用）。空清单跳过技能安装；技能根不可用 / 写失败仍 200 + warning。真机技能探针：写入后当前会话技能列表未刷新（32→32），新会话 / 重启后是否可见 not-run（§4.2-8）。
