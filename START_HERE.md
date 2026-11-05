# START_HERE · Manager（ai-pet 根）

> 本窗口 = **Manager**。不要在这里改 src/**。

## 一键开场（复制到 Agent 输入框后发送）

```text
你是本仓的 Manager（管理层）。工作区必须是仓库根（含 .team/）。

先读 .team/MANAGER.md、.team/CURSOR_SESSIONS.md、.team/PROTOCOL.md、.team/BULLETIN.md，
再跑：
  node .team/tools/team.mjs status
  node .team/tools/team.mjs doctor
用中文回报板子与下一步。不要改业务代码（src/**）。

板子上应有待认领 T-020 / T-021；执行会话 cwd 分别为对应 team-worktrees。开场材料见本目录 START_HERE.md。
```

## 本机材料

| 角色 | 路径 |
|---|---|
| 分会话说明 | `.team/CURSOR_SESSIONS.md` |
| 模板 | `.team/cursor-prompts/` |
| 执行 T-020 | `D:/01_Projects/Active/ai-pet.team-worktrees/T-020` + `START_HERE.md` |
| 执行 T-021 | `D:/01_Projects/Active/ai-pet.team-worktrees/T-021` + `START_HERE.md` |
| 集成（可选） | `D:/01_Projects/Active/ai-pet.team-worktrees/integration` |

## 一键脚本

```powershell
pwsh -NoProfile -File .\scripts\open-cursor-sessions.ps1
```
