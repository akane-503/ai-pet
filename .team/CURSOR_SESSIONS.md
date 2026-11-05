# Cursor 分会话（ai-pet）

> 适配材料源：`D:/01_Projects/Active/project-team-pm/adapters/cursor/`  
> 控制面：见 `CONTROL_PLANE.md`。

## 一条命令（推荐）

```powershell
pwsh -NoProfile -File D:\01_Projects\Active\ai-pet\scripts\open-cursor-sessions.ps1 -Integration
```

这会自动：刷新各角色 `START_HERE.md`、创建并种子化 4 个 Agent CLI 会话、打开 4 个 Cursor 窗口并定位到 `START_HERE.md`、剪贴板预填 Manager 开场。

会话 ID 落盘：`.team/local/cursor-open/sessions.json`  
多根工作区备选：`ai-pet-team.code-workspace`（加 `-MultiRoot`）。

### 你还要点一下什么

1. 每个 Cursor 窗口：Agent 输入框 **Ctrl+V**（Manager 已在剪贴板）或 **@START_HERE.md** → Send 一次。  
2. 或终端继续：`agent --workspace <路径> --resume <chatId>`（见 sessions.json）。  
3. **边界**：无法把文字直接打进 GUI 聊天框；CLI 会话已注入首条。Ask 种子不能跑写操作；执行任务请切 Agent 模式或加 `-RunExecutors`。

## 已挂接

| 项 | 路径 |
|---|---|
| 一键脚本 | `scripts/open-cursor-sessions.ps1` |
| START_HERE | 仓根 / T-020 / T-021 / integration |
| Cursor 规则 | `.cursor/rules/project-team.mdc` |
| skill | `%USERPROFILE%\.cursor\skills\project-team` |
| 开场模板 | `.team/cursor-prompts/` |

## 手动开聊（脚本不可用时）

见 `.team/cursor-prompts/` 与 `adapters/cursor/SESSIONS.md`。