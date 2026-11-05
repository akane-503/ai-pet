# Launch · E-002 → claude-code

## Checklist（可 dry-run：只读脚本不自动弹 GUI）

1. 安装适配：`node <pm>/adapters/_install.mjs --host claude-code --repo <仓> --skill`
2. 打开宿主 **claude-code**，cwd：
   `D:\01_Projects\Active\ai-pet.team-worktrees\T-011`
3. 粘贴 BRIEF 全文：`D:\01_Projects\Active\ai-pet\.team\engagements\E-002\BRIEF.md`
4. 完成后：`engage deliver` → Manager `engage accept --integrate`

## 宿主提示

- Claude Code：打开 worktree；粘贴或 @ BRIEF；遵守 CLAUDE.md

## 一键打印（本机）

```powershell
pwsh -NoProfile -File "D:/01_Projects/Active/ai-pet/.team/engagements/E-002/launch.ps1"
```

