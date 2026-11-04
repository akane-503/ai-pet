<!-- project-team:begin -->
## 项目团队协议（project-team）

本项目用 `.team/` 管理多会话协作。任何会话开工前先读 `.team/BULLETIN.md` 和 `.team/PROTOCOL.md`。

**硬规则：**

1. 管理层不写业务代码；执行者只写任务书写集（`write`）内的文件。
2. 不改 `.team/` 控制面；不改别人的任务；不删公告栏行。
3. 状态、证据、交接只认 `node .team/tools/team.mjs` 和公告栏，不认对话记忆。
4. 先 `claim` 再干活；写集冲突未裁决前不得继续写重叠路径。
5. 需要人工验收的项标 `needsHuman`，`accept` 必须 `--human-ok`，不许自勾完成。
6. 范围/优先级/结构变更走 CR；执行者不得自行扩大写集。
7. 依赖目录若是共享链接（`node_modules`/`.venv`），禁止在任务工作树里安装/升级依赖；改依赖走 CR 或集成者。

**常用：**

```text
node .team/tools/team.mjs status
node .team/tools/team.mjs bulletin
node .team/tools/team.mjs task add --title "..." --module <模块> --write "<glob>" --verify "<命令>"
node .team/tools/team.mjs dispatch --id T-001
node .team/tools/team.mjs claim --id T-001 --token <token>
node .team/tools/team.mjs submit --id T-001 --token <token>
node .team/tools/team.mjs integrate --id T-001
node .team/tools/team.mjs accept --id T-001
```

派子会话时：`subagent` 的 `cwd` 用任务工作树，prompt 用 `.team/local/sessions/T-001.md` 的全文。
在任务工作树里执行时，用会话简报里的**控制面绝对路径**调用 CLI；工作树里的 `.team/tools/team.mjs` 可能落后于控制面。

控制面独立仓：D:/01_Projects/Active/project-team-pm（见 .team/CONTROL_PLANE.md）。刷新 CLI 从该仓 skill/scripts/team.mjs 复制到 .team/tools/。
<!-- project-team:end -->

<!-- project-team-pm:cursor:begin -->
## project-team-pm（Cursor 适配）

- 控制面：`.team/` + `node .team/tools/team.mjs`（源仓 `D:/01_Projects/Active/project-team-pm`）
- Manager：顶层 Agent / Project；执行：Task，cwd = worktree，prompt = sessions 简报
- 决策：`.team/DECISIONS.md`；可选 `managerd`
- 安装：`node <pm>/adapters/_install.mjs --host cursor --repo <仓> [--skill]`
<!-- project-team-pm:cursor:end -->

<!-- project-team-pm:generic:begin -->
## project-team-pm（通用 CLI 适配）

- 任意能读 Markdown、跑 Node ≥ 20 的 Agent 可用
- Manager：`.team/MANAGER.md` → `status` / `doctor` / `dispatch`
- 执行者：claim → 写集 → submit；决策进 `DECISIONS.md`
- 安装说明块：`node <pm>/adapters/_install.mjs --host generic --repo <仓>`
- 源仓：`D:/01_Projects/Active/project-team-pm`
<!-- project-team-pm:generic:end -->

<!-- project-team-pm:dsh:begin -->
## project-team-pm（DSH 适配）

- 部署技能：`node <pm>/adapters/_install.mjs --host dsh --skill`
  → `%USERPROFILE%\.dsh\skills\project-team`（junction 到独立仓 skill）
- Manager：`subagent` 扇出；cwd = 任务 worktree；`link --session <id>`
- 勿再用 `dsh/lab/skills/project-team` 当真相源（见 `docs/dual-source.md`）
<!-- project-team-pm:dsh:end -->
