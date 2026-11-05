# 控制面源（CONTROL_PLANE）

本仓是 **ai-pet 桌宠产品**；跨工具项目管理控制面在独立仓：

| 项 | 路径 |
|---|---|
| 控制面仓 | `D:/01_Projects/Active/project-team-pm` |
| 技能包 | `D:/01_Projects/Active/project-team-pm/skill` |
| CLI（源） | `D:/01_Projects/Active/project-team-pm/bin/team.mjs` |
| 本仓运行时 CLI | `node .team/tools/team.mjs`（由技能 `scripts/team.mjs` 复制；升级用下方 refresh） |
| Manager 守护（源） | `D:/01_Projects/Active/project-team-pm/services/manager-daemon.mjs` |
| Manager 守护（本仓） | `node .team/tools/managerd.mjs`（init/--tools-only 时从技能复制） |
| 宿主适配 | `D:/01_Projects/Active/project-team-pm/adapters/` |

刷新本仓 CLI/模板（不改业务代码）：

```powershell
node .team/tools/team.mjs init --tools-only
# 或手动：
Copy-Item -Force "D:\01_Projects\Active\project-team-pm\skill\scripts\team.mjs" ".team\tools\team.mjs"
Copy-Item -Force "D:\01_Projects\Active\project-team-pm\skill\scripts\engagement.mjs" ".team\tools\engagement.mjs"
Copy-Item -Force "D:\01_Projects\Active\project-team-pm\skill\scripts\managerd.mjs" ".team\tools\managerd.mjs"
Copy-Item -Force "D:\01_Projects\Active\project-team-pm\skill\templates\*" ".team\tools\templates\"
```

或：`node D:/01_Projects/Active/project-team-pm/bin/team.mjs` 在任意子目录也能解析到本仓 `.team/`（向上查找）。

历史副本：`D:/01_Projects/Active/dsh/lab/skills/project-team`（勿再当真相源）。

> 注：.team/config.json 被仓库根 config.json* 规则忽略，故 controlPlane 字段以本文件为准写入 git；本地 config 可另存同名字段便于脚本读取。
