# 归置（Stow）

看清你装了什么，按你的工作流归置成能用的工具包。

> 工欲善其事，必先利其器。

归置是一个 DeepSeek Harness（DSH）插件：只读地列出本机已装的插件、技能和工具，按你的实际工作流重新归置成「工具包」（一组插件行 + 工具 + 技能），标出缺的与多余的；工具包可以导出，也可以在你确认后装进 DSH。它不改预设、不做团队编排、不做插件市场。

## 状态

v0.1 设计定稿，尚未开工。实施计划见 [docs/superpowers/plans/2026-11-26-guizhi-v1.md](docs/superpowers/plans/2026-11-26-guizhi-v1.md)。

## 文档

- 设计：[docs/superpowers/specs/2026-11-26-guizhi-design.md](docs/superpowers/specs/2026-11-26-guizhi-design.md)
- 计划：[docs/superpowers/plans/2026-11-26-guizhi-v1.md](docs/superpowers/plans/2026-11-26-guizhi-v1.md)

## 技术栈

- DSH >= 0.2.2，Node >= 24.9.0
- 纯 ESM，无构建步骤；`node --test`
- 运行时依赖：`yaml`
- 包名：`@fanyingnie/dsh-guizhi`（npm 已查为空）
