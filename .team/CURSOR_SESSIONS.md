# Cursor 分会话（ai-pet）

> 适配材料源：`D:/01_Projects/Active/project-team-pm/adapters/cursor/`  
> 控制面：见 `CONTROL_PLANE.md`。

## 默认（板已清）

侧栏只保留 **1 个文件夹根：`ai-pet`**（仓根）。

```powershell
pwsh -NoProfile -File D:\01_Projects\Active\ai-pet\scripts\open-cursor-sessions.ps1
```

工作区：`ai-pet-team.code-workspace`（单根）。T-020 / T-021 已完成，不再挂进 workspace。

## 已挂接

| 项 | 路径 |
|---|---|
| 一键脚本 | `scripts/open-cursor-sessions.ps1` |
| 全自动 | `scripts/team-auto.ps1` |
| 会话地图 | `SESSION_MAP.md` |
| Cursor 规则 | `.cursor/rules/project-team.mdc` |
| skill | `%USERPROFILE%\.cursor\skills\project-team` |

归档用单角色 workspace（**默认不要开**）仍在 `.team/cursor-sessions/`。
