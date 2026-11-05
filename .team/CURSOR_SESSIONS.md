# Cursor 分会话（ai-pet）

> 适配材料源：`D:/01_Projects/Active/project-team-pm/adapters/cursor/`  
> 控制面：见 `CONTROL_PLANE.md`。本文件给人 / Agent 复制开场用。

## 已挂接

| 项 | 路径 |
|---|---|
| 控制面 CLI | `node .team/tools/team.mjs` |
| managerd | `node .team/tools/managerd.mjs` |
| Cursor 规则 | `.cursor/rules/project-team.mdc`（alwaysApply） |
| Cursor skill | `%USERPROFILE%\.cursor\skills\project-team` → project-team-pm/skill |
| 开场模板 | `.team/cursor-prompts/{manager,executor,integration}.md` |
| AGENTS 块 | 根目录 `AGENTS.md`（project-team + cursor） |

## 三个会话怎么开

### 1) Manager（必开）

1. Cursor → 打开文件夹 `D:\01_Projects\Active\ai-pet`（根检出）。
2. 新 Agent / Chat。
3. 粘贴 `.team/cursor-prompts/manager.md` 里的代码块（或 `.team/MANAGER.md` 顶部开场句）。
4. 等它跑完 `status` / `doctor` 再派单。

### 2) Executor（每任务一个）

1. Manager 先：`task add` → commit `.team` → `dispatch --id T-0xx`。
2. 新 Agent；**Working Directory** 设为简报中的 worktree（如 `D:\01_Projects\Active\ai-pet.team-worktrees\T-0xx`）。
3. 把 `.team/local/sessions/T-0xx.md` **全文**粘贴为第一条消息。
4. 执行者 claim → 改写集 → submit。
5. Manager：`link T-0xx --session <该 Cursor 会话 id>`（便于 status 对上人）。

### 3) Integration（可选）

1. 新 Agent，工作区仍可用仓根。
2. 粘贴 `.team/cursor-prompts/integration.md`。
3. 只跑 `integrate` / `accept`，不改功能代码。

## 产品切片 worktree（可选长期会话）

已有：`product-install` / `interaction` / `quota` / `transfer` / `notifications` / `settings`。  
可当执行会话 cwd，但仍须有 board 任务 + claim；合并走 `team/integration`。

## 并行注意

- 写集重叠看 `status`；冲突先 `arbitrate`。
- `src/main/main.js` 热点：尽量拆模块或串行。
- 不要 taskkill / 动真装；破坏性操作写 `DECISIONS.md`。
