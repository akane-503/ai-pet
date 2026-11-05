# Cursor 分会话说明（ai-pet）

本仓用三个 Cursor 会话分工：管理层拆任务和验收，执行者只改自己的写集，集成者只做合并与门禁。怎么开窗、粘贴哪段开场，以 [`.team/CURSOR_SESSIONS.md`](../.team/CURSOR_SESSIONS.md) 为准；可复制模板在 [`.team/cursor-prompts/`](../.team/cursor-prompts/)。

状态只认 `node .team/tools/team.mjs` 和 [`.team/BULLETIN.md`](../.team/BULLETIN.md)，不认对话记忆。协议见 [`.team/PROTOCOL.md`](../.team/PROTOCOL.md)。

## 角色

| 会话 | 工作区 | 做什么 | 不做什么 |
|---|---|---|---|
| **Manager** | 仓库根 `D:\01_Projects\Active\ai-pet`（含 `.team/`） | 读板、拆任务、`dispatch`、决策、协调验收。开场用 [`.team/cursor-prompts/manager.md`](../.team/cursor-prompts/manager.md) | 不写业务代码（`src/**`、脚本业务逻辑、`dist`） |
| **Executor** | 每任务一个工作树 `D:\01_Projects\Active\ai-pet.team-worktrees\T-00x`，分支 `task/T-00x` | `claim` → 只改任务写集 → 小步提交 `task(T-00x): ...` → `submit`。第一条消息粘贴 `.team/local/sessions/T-00x.md` 全文 | 不改 `.team/`；不开子会话；不扩大写集；任务树里不 `npm install` |
| **Integration**（可选） | 仓根，或 `D:\01_Projects\Active\ai-pet.team-worktrees\integration`（分支 `team/integration`） | 任务为「待验收」且证据齐全后跑 `integrate` / `accept`。开场用 [`.team/cursor-prompts/integration.md`](../.team/cursor-prompts/integration.md) | 不改功能代码；不绕过门禁；冲突不手改，等 Manager 裁决 |

执行会话里的 team 命令用控制面绝对路径 `node D:\01_Projects\Active\ai-pet\.team\tools\team.mjs`。工作树里的 `.team/tools/team.mjs` 是基线副本，可能过期。

## 怎么配合

```text
[Manager · 根检出]
    ├─ dispatch T-0xx → [Executor · task/T-0xx]
    ├─ dispatch T-0yy → [Executor · task/T-0yy]   （写集不重叠才并行）
    └─ （可选）[Integration · team/integration]
```

- 派单后 Manager 用 `link T-00x --session <Cursor 会话 id>` 把人和任务对上。
- 写集重叠先看 `status`，再 `arbitrate`，未裁决前不写重叠路径。
- 需要安装、杀进程、改注册表或删数据时，执行者停手，由 Manager 在 `.team/DECISIONS.md` 裁决。
- 产品切片工作树（`product-install` 等）可以当长期执行会话的目录，仍须先有任务再 `claim`。路径表见 [`.team/ARCHITECTURE.md`](../.team/ARCHITECTURE.md) 第 5 节。
