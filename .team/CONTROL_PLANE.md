# 控制面源（CONTROL_PLANE）

本仓是 **ai-pet 桌宠产品**；跨工具项目管理控制面在独立仓：

| 项 | 路径 |
|---|---|
| 控制面仓 | `D:/01_Projects/Active/project-team-pm` |
| 技能包 | `D:/01_Projects/Active/project-team-pm/skill` |
| CLI（源） | `D:/01_Projects/Active/project-team-pm/bin/team.mjs` |
| 本仓运行时 CLI | `node .team/tools/team.mjs`（由技能 `scripts/team.mjs` 复制；升级用下方 refresh） |
| Manager 守护 | `D:/01_Projects/Active/project-team-pm/services/manager-daemon.mjs` |
| 宿主适配 | `D:/01_Projects/Active/project-team-pm/adapters/` |

刷新本仓 CLI/模板（不改业务代码）：

```powershell
Copy-Item -Force "D:\01_Projects\Active\project-team-pm\skill\scripts\team.mjs" ".team\tools\team.mjs"
Copy-Item -Force "D:\01_Projects\Active\project-team-pm\skill\templates\*" ".team\tools\templates\"
```

或：`node D:/01_Projects/Active/project-team-pm/bin/team.mjs` 在任意子目录也能解析到本仓 `.team/`（向上查找）。

历史副本：`D:/01_Projects/Active/dsh/lab/skills/project-team`（勿再当真相源）。