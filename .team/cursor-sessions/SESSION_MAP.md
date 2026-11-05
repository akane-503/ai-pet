# SESSION_MAP · 侧栏已收拢（单根）

**左侧资源管理器现在只有 1 项：**

| 侧栏名 | 路径 | 说明 |
|---|---|---|
| **ai-pet** | `D:/01_Projects/Active/ai-pet` | 仓根（唯一文件夹根） |

T-020 / T-021 已完成 → **已从 workspace 去掉**（不再占侧栏）。
旧的多窗 / 多根（Manager、Exec、Integration）**不要再开**。

## 默认打开（干净 workspace）

```powershell
pwsh -NoProfile -File D:\01_Projects\Active\ai-pet\scripts\open-cursor-sessions.ps1
```

全自动 CLI（可选再开 GUI）：

```powershell
pwsh -NoProfile -File D:\01_Projects\Active\ai-pet\scripts\team-auto.ps1
pwsh -NoProfile -File D:\01_Projects\Active\ai-pet\scripts\team-auto.ps1 -Gui
```

工作区文件：`D:\01_Projects\Active\ai-pet\ai-pet-team.code-workspace`（folders 仅 1 条）。

## 用户现在应看到

- Cursor 左侧：**一个**根文件夹，名叫 **ai-pet**
- 窗口标题：**ai-pet**
- 没有「【2】T-020 已完成」「【3】T-021 已完成」等多余根

## DSH 验证

```powershell
node D:\01_Projects\Active\ai-pet\.team\tools\team.mjs status
```
