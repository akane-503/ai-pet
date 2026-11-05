# Launch · E-003 → dsh

## Checklist（可 dry-run：只读脚本不自动弹 GUI）

1. 安装适配：`node <pm>/adapters/_install.mjs --host dsh --repo <仓> --skill`
2. 打开宿主 **dsh**，cwd：
   `D:\01_Projects\Active\ai-pet`
3. 粘贴 BRIEF 全文：`D:\01_Projects\Active\ai-pet\.team\engagements\E-003\BRIEF.md`
4. 完成后：`engage deliver` → Manager `engage accept --integrate`

## 宿主提示

- DSH：subagent cwd = worktree；prompt = BRIEF；然后 link --session

## 一键打印（本机）

```powershell
pwsh -NoProfile -File "D:/01_Projects/Active/ai-pet/.team/engagements/E-003/launch.ps1"
```

