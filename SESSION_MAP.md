# 会话一览（给你看的名字）

> 每个 Cursor 窗口标题 / 侧栏根名如下。打开脚本会按这些名字开窗。

| 窗口名（标题栏） | 角色 | 任务 | 干什么 | workspace 文件 |
|---|---|---|---|---|
| 【Manager】管板 · ai-pet | manager | — | 拆任务 / dispatch / engage / 验收；不写业务代码 | `.team/cursor-sessions/01-Manager-管板.code-workspace` |
| 【Exec·T-020】Cursor 会话地图 | T-020 | T-020 docs: Cursor session map for ai-pet | 写 docs/cursor-sessions.md（分会话说明） | `.team/cursor-sessions/02-Exec-T-020-Cursor会话地图.code-workspace` |
| 【Exec·T-021】控制面指针 | T-021 | T-021 docs: control-plane pointer | 写 docs/control-plane.md（PM 指针） | `.team/cursor-sessions/03-Exec-T-021-控制面指针.code-workspace` |
| 【Integration】集成验收 | integration | — | integrate / accept；有待验收才动手 | `.team/cursor-sessions/04-Integration-集成.code-workspace` |

## 一键开命名窗口

```powershell
pwsh -NoProfile -File .\scripts\open-cursor-sessions.ps1 -Integration -Seed
```
