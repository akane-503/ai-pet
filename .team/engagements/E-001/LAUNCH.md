# Launch · E-001 → codex

## Checklist（可 dry-run：只读脚本不自动弹 GUI）

1. 安装适配：`node <pm>/adapters/_install.mjs --host codex --repo <仓> --skill`
2. 打开宿主 **codex**，cwd：
   `D:\01_Projects\Active\ai-pet.team-worktrees\T-010`
3. 粘贴 BRIEF 全文：`D:\01_Projects\Active\ai-pet\.team\engagements\E-001\BRIEF.md`
4. 完成后：`engage deliver` → Manager `engage accept --integrate`

## 宿主提示

- Codex：新 thread，working directory = worktree；粘贴 BRIEF

## 一键打印（本机）

```powershell
pwsh -NoProfile -File "D:/01_Projects/Active/ai-pet/.team/engagements/E-001/launch.ps1"
```

