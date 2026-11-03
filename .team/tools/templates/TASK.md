---
id: {{ID}}
title: {{TITLE}}
module: {{MODULE}}
priority: {{PRIORITY}}
status: 待认领
write:
{{WRITE}}
read:
{{READ}}
depends: [{{DEPS}}]
verify: {{VERIFY}}
---

# {{ID}} {{TITLE}}

## 背景 / 目标

{{CONTEXT}}

## 边界（明确不做）

- 不碰写集外的文件。
- 不改 `.team/` 控制面。
- 不自行扩大范围；需要新能力先向 manager 提 CR / 改任务书。

## 依赖

{{DEPS}}

## 验收

{{ACCEPT}}

- 命令：`{{VERIFY}}`
- 证据：提交号 + 命令输出 + 文件清单（`submit` 自动记录）
- 需要人工验收？在任务里写明，并 `submit --needs-human`。

## 执行步骤

1. 读 `PROTOCOL.md`、`BULLETIN.md`、本任务书、会话简报。
2. `node .team/tools/team.mjs claim {{ID}} --token <token>`（必须在本任务 worktree 内）。
3. 只在写集内改；小步提交（`task({{ID}}): ...`）。
4. `node .team/tools/team.mjs submit {{ID}} --token <token>`。
5. 卡住：`report {{ID}} --token <token> --status blocked --note "..."`，然后停。

## 回报格式

- 改了什么（文件 / 行为）：
- 证据（命令、退出码、提交号）：
- 没做完 / 风险：
- 下一步建议：
