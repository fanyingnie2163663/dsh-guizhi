<p align="center">
  <img src="icon.svg" width="72" height="72" alt="归置 Stow" />
</p>

<h1 align="center">归置 · Stow</h1>

<p align="center"><b>看清你装了什么，按你的工作流归置成能用的工具包。</b></p>

<p align="center">
  <a href="https://github.com/fanyingnie2163663/dsh-guizhi/actions"><img src="https://img.shields.io/badge/tests-280%20passing-2ea44f" alt="tests"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524.9-339933" alt="node">
  <img src="https://img.shields.io/badge/DSH-%E2%89%A50.2.2-4d6bfe" alt="dsh">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license">
  <img src="https://img.shields.io/badge/status-v0.1-8b5cf6" alt="status">
</p>

<p align="center">
  <a href="#它解决什么">它解决什么</a> ·
  <a href="#三屏面板">三屏面板</a> ·
  <a href="#安装">安装</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#数据与隐私">数据与隐私</a> ·
  <a href="#开发">开发</a>
</p>

---

**归置（Stow）** 是一个 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) 插件：只读盘点本机已装的 **插件 / 技能 / 工具** 与近 30 天用量，按你的工作流拆成阶段、标出**缺口与冗余**，生成可导出的**能力包**。任何写操作都先预览、写快照、可回滚。它不改你的预设、不做团队编排、不做插件市场。

> 工欲善其事，必先利其器。—— 先归置，再开工。

## 三屏面板

![左侧栏入口与三屏总览](docs/assets/ui-overview.png)

**入口**：DSH 左侧栏面板列表里的「归置」行（排在「定时」之后、「技能中心」之前，`PANEL_ORDER 20`；hover 由 shell 显示「归置」tooltip）——产品记忆点落在左栏；点击后三屏内容在中央区展开。

| 清爽 | 场景 | 地图 |
|:---:|:---:|:---:|
| 家底：插件 / 工具 / 技能 / 近 30 天未用 + 工具表（归属、用量、最后使用）；未知用量显示「未知」，绝不写成 0。 | 6 个内置场景多选 + 一句自定义，保存为工作流选择。 | 阶段卡片 + 能力点（绿=已有、琥珀=缺、灰=冗余），点开看证据；底部查缺补漏 / 生成工具包 / 预览 / 应用 / 回滚。 |

<details>
<summary>单独看三屏大图</summary>

| 清爽 | 场景 | 地图 |
|:---:|:---:|:---:|
| ![清爽页](docs/assets/ui-clean.png) | ![场景页](docs/assets/ui-scenes.png) | ![地图页](docs/assets/ui-map.png) |

</details>
| 家底：插件 / 工具 / 技能 / 近 30 天未用 + 工具表（归属、用量、最后使用）；未知用量显示「未知」，绝不写成 0。 | 6 个内置场景多选 + 一句自定义，保存为工作流选择。 | 阶段卡片 + 能力点（绿=已有、琥珀=缺、灰=冗余），点开看证据；底部查缺补漏 / 生成工具包 / 预览 / 应用 / 回滚。 |

> 无 DSH 也可先看纯静态视觉预览：[`docs/ui-preview.html`](docs/ui-preview.html)（示例数据，非真实面板）。

## 它解决什么

| 你遇到的问题 | 归置的回答 |
|---|---|
| 装了很多插件，不知道谁带来了哪个工具、哪些从没用过、哪些重复。 | **清爽页**一次盘点：工具 → 归属插件、近 30 天调用次数、最后使用时间；未知就写未知。 |
| 知道缺什么，但不知道按当前工作流该怎么组合。 | **场景 → 地图**：6 个内置场景拆成阶段，每个阶段挂能力点并带证据。 |
| 想调整，怕改坏。 | **提案 → 预览 → 应用 → 回滚**：先出 diff 与稳定 hash；应用先写快照、备份被覆盖文件、记台账；回滚幂等。 |
| 外部目录不可靠。 | 目录源 **schema 校验 + 缓存 + fail-open**：不可达/格式错会明确报错，绝不显示成「没有缺口」。 |

## 架构

```text
┌────────────── DSH Web GUI ──────────────┐
│  侧栏「归置」面板（client.js，三屏）      │
│      │ fetch api/guizhi/*  每 3s 轮询     │
└──────┼──────────────────────────────────┘
       ▼
┌────────────── 宿主插件（lib/index.js） ──┐
│  HTTP 路由 /api/guizhi/*                 │
│  9 个 agent 工具  stow_*                 │
│  ┌ lib/routes.js ─ 薄壳与校验/I-O 边界 ┐  │
│  │ scan · usage · scenarios · map      │  │
│  │ catalog · packs · preview/apply     │  │
│  │ attribution · store · schemas       │  │
│  └─────────────────────────────────────┘  │
│  数据根 $DSH_HOME/guizhi/（JSON + 快照）  │
└───────────────────────────────────────────┘
```

纯 ESM、无构建步骤、无运行时框架；插件自身**不调用模型 API**，AI 只在会话里由 agent 调 `stow_*` 工具参与。

## 安装

要求：DSH Desktop `≥ 0.2.2`（开发基线 `0.2.2-rc.5`）、Node `≥ 24.9`。

<details>
<summary><b>方式一：GUI（推荐）</b></summary>

1. 打开 DSH 的插件页，选择「从本地安装」，指向本仓库目录（或发布后的 npm 包名）。
2. 重启 DSH（插件行与客户端面板在启动时加载）。
3. 侧栏出现「归置」行，点开即三屏面板。
</details>

<details>
<summary><b>方式二：CLI</b></summary>

```bash
dsh plugin --profile <profile> add /path/to/dsh-guizhi
# 或发布后：
dsh plugin --profile <profile> add @fanyingnie2163663/dsh-guizhi
```

> 插件改动只对**下一个会话 / 重启后**生效。
</details>

<details>
<summary><b>方式三：手动编辑 profile（无 CLI 时）</b></summary>

1. 将本仓库 `cordis.patch.yml` 的 insert 行合并进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`；
2. 在该 profile 的 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中加入本包；
3. 在 profile 目录执行 `pnpm install`，然后重启 DSH。

完整手动步骤与验证判据见 [`docs/DEMO.md`](docs/DEMO.md) §4 与 [`docs/host-notes.md`](docs/host-notes.md) §8。
</details>

## 快速开始

1. **清爽**页点「重新扫描」：只读盘点本机，不调模型。
2. **场景**页选场景 + 写一句自定义，保存。
3. 让会话 agent 用 `stow_map_save` 把工作流落成阶段地图（阶段 + 能力点 + 证据）。
4. **地图**页点「查缺补漏」：从公共目录匹配缺口（不可达会明确报错）。
5. 点「生成工具包」：只生成 `kind=pack` **提案**，不落盘。
6. 点「预览变更」：看 diff 与稳定 hash，确认要应用的条目。
7. 点「应用」：先写快照、备份被覆盖的旧包、记台账，再导出 `packs/<id>.json`。
8. 点「回滚」：删除本次新建包、恢复被覆盖旧包、恢复状态；重复回滚幂等。

### Agent 工具（9 个 `stow_*`）

| 工具 | 作用 |
|---|---|
| `stow_scan` | 只读扫描插件 / 技能 / 工具与近 30 天用量 |
| `stow_status` | 状态汇总（家底、用量是否未知、最近扫描） |
| `stow_map_save` | 保存工作流地图（阶段 / 能力点 / 证据） |
| `stow_pack_build` | 由地图阶段生成能力包提案 |
| `stow_gaps` | 目录匹配缺口并生成提案 |
| `stow_preview` | 预览要应用的变更与 hash |
| `stow_apply` | 应用（先快照、再写包文件） |
| `stow_rollback` | 回滚指定快照 |
| `stow_draft` | 生成「这个活只需要 A/B/C」派单草稿（不代发） |

### HTTP 路由

`GET /api/guizhi/state` · `POST /api/guizhi/{scan,scenarios,map,pack,gaps,preview,apply,rollback,draft}`（仅本机 loopback，按插件内围栏拒绝远端）。

## 数据与隐私

```text
$DSH_HOME/guizhi/
├── scan.json          # 最近一次扫描
├── map.json           # 工作流阶段 / 能力点 / 证据
├── proposals.json     # 缺口与 pack 提案
├── selections.json    # 场景选择
├── packs.json         # /pack 生成时的 pack 内容（保证 preview=apply）
├── sources.json       # 公共目录源配置
├── packs/<id>.json    # apply 后导出的能力包
└── snapshots/<id>/    # 快照 + packs-created.json 台账 + packs-backup/
```

- **只读扫描**：不读凭据、不读与插件/技能无关的会话内容；用量只取工具调用名与时间，不上行、不落盘明细。
- **不调模型**：插件自身不调用任何模型 API。
- **写操作可回滚**：任何落盘先写快照、备份被覆盖文件、记台账；回滚幂等。
- **外部目录只当数据**：format-1 索引做 schema 校验、缓存、fail-open；内容不执行、不自动安装。
- **v1 不写 profile**：`install` 类提案只提示，不安装插件行（v1.1）。

## 开发

```bash
pnpm install                    # 仅 yaml 运行时依赖
node --test test/*.test.js      # 280 个测试
node --check client.js lib/*.js # 语法检查（无构建步骤）
```

```text
lib/           纯函数与 I/O 层（scan / usage / scenarios / map / catalog / packs / apply / routes / store / schemas / host / attribution / http）
client.js      DSH client 插件：三屏面板（无构建步骤，React.createElement）
cordis.patch.yml  插件行
docs/          设计、计划、宿主 API 笔记、演示脚本、UI 静态预览
test/          node:test：单元 + 路由 + HTTP 适配 + e2e
```

## 状态与已知限制

- **v0.1 功能已实现**：280/280 测试通过（分支 `v1`，尚未合并/发布）。
- **真机验证仍待执行**：安装、重启、面板渲染、路由可达、9 工具真实注册调用、≥20 插件真机扫描、录屏、用户测试 —— 步骤见 [`docs/DEMO.md`](docs/DEMO.md) §4；本 README 不宣称真机通过。
- **v1 未实现（→ v1.1 backlog）**：插件行安装与「需要新会话/重启」提示、能力点「生效方式/需单开会话」徽章、清爽页重复/冲突与上下文成本、应用抽屉逐条启用/忽略、冗余提案与来源信任等级、无 client 插件时的 HTML 报告兜底、场景→工作流自动拆解。

## 文档

- 设计：[`docs/superpowers/specs/2026-11-26-guizhi-design.md`](docs/superpowers/specs/2026-11-26-guizhi-design.md)
- 计划：[`docs/superpowers/plans/2026-11-26-guizhi-v1.md`](docs/superpowers/plans/2026-11-26-guizhi-v1.md)
- 宿主 API 笔记：[`docs/host-notes.md`](docs/host-notes.md)
- 演示与验收：[`docs/DEMO.md`](docs/DEMO.md)
- UI 静态预览：[`docs/ui-preview.html`](docs/ui-preview.html)

## License

MIT © 2026 聂凡瑛（fanyingnie）
