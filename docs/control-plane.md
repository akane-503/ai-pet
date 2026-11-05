# 控制面指针（ai-pet）

本仓是桌宠产品。跨工具项目管理的控制面在独立仓 `project-team-pm`，不在 `src/` 里。本页只指路：仓在哪、`team.mjs` 怎么调。协议与状态以 [`.team/CONTROL_PLANE.md`](../.team/CONTROL_PLANE.md)、[`.team/PROTOCOL.md`](../.team/PROTOCOL.md)、[`.team/BULLETIN.md`](../.team/BULLETIN.md) 为准。

## 路径

| 项 | 路径 |
|---|---|
| 控制面仓 | `D:/01_Projects/Active/project-team-pm` |
| 技能包 | `D:/01_Projects/Active/project-team-pm/skill` |
| CLI（源） | `D:/01_Projects/Active/project-team-pm/bin/team.mjs` |
| 本仓运行时 CLI | `node .team/tools/team.mjs`（从技能 `scripts/team.mjs` 复制） |
| 任务工作树里调用 | `node D:\01_Projects\Active\ai-pet\.team\tools\team.mjs` |
| Manager 守护（源） | `D:/01_Projects/Active/project-team-pm/services/manager-daemon.mjs` |
| Manager 守护（本仓） | `node .team/tools/managerd.mjs` |
| 宿主适配 | `D:/01_Projects/Active/project-team-pm/adapters/` |

工作树里的 `.team/tools/team.mjs` 是派单时的基线副本，可能过期。执行会话一律用上表的控制面绝对路径。`node D:/01_Projects/Active/project-team-pm/bin/team.mjs` 在本仓任意子目录会向上找到 `.team/`。

历史副本 `D:/01_Projects/Active/dsh/lab/skills/project-team` 不再当真相源。

刷新本仓 CLI 与模板（不改业务代码）：在仓库根运行 `node .team/tools/team.mjs init --tools-only`。

## 命令

用法：`node .team/tools/team.mjs <命令> [参数]`。部分命令支持 `--json`。退出码：`0` 成功，`2` 用法或状态，`3` 冲突或越权，`4` 门禁或合并失败。

| 分组 | 命令 |
|---|---|
| 健康 | `init` `doctor` `status` `manager` `bulletin` `note` |
| 任务 | `task add` `task list` `task show` |
| 派单 / 执行 | `dispatch` `link` `claim` `renew` `release` `report` `submit` `handoff` |
| 集成 / 验收 | `integrate` `accept` `reject` `reopen` `close` `clean` |
| 外包 | `engage new\|out\|start\|deliver\|accept\|reject\|cancel\|list\|show\|brief` |
| 变更 / 仲裁 | `cr new` `cr impact` `cr apply` `arbitrate` |

`claim` / `submit` 必须在该任务工作树里跑，并带会话简报里的 token。完整参数见 `node .team/tools/team.mjs --help`。

## 不是业务代码

- 本文件和 `.team/` 只描述协作，不含桌宠功能、窗口、额度或转接逻辑。
- 管理层不改 `src/**`。执行者只改任务写集，不改 `.team/`，不扩大范围。
- 任务工作树里不 `npm install`、不升级依赖（`linkDirs` 共享）。
- 状态、证据、交接只认 CLI 与公告栏。
