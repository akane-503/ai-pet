<#
.SYNOPSIS
  Open the clean single-root ai-pet workspace (default).
  Pass -Auto to also run team-auto.ps1 first. Pass -NewWindow for a fresh window.
#>
[CmdletBinding()]
param(
  [switch]$Auto,
  [switch]$NewWindow,
  # Legacy no-ops kept so old call sites do not break
  [switch]$Gui,
  [switch]$Integration,
  [switch]$MultiRoot
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\01_Projects\Active\ai-pet'
$Workspace = Join-Path $Root 'ai-pet-team.code-workspace'

if ($MultiRoot) {
  Write-Warning 'T-020/T-021 已完成；忽略 -MultiRoot，只开仓根单文件夹。'
}
if ($Integration) {
  Write-Warning '板已清；忽略 -Integration，只开仓根单文件夹。'
}

if ($Auto) {
  & (Join-Path $PSScriptRoot 'team-auto.ps1')
}

# Ensure clean single-root workspace on disk
@'
{
  "folders": [
    {
      "name": "ai-pet",
      "path": "D:/01_Projects/Active/ai-pet"
    }
  ],
  "settings": {
    "window.title": "ai-pet",
    "window.titleSeparator": " · "
  }
}
'@ | Set-Content -LiteralPath $Workspace -Encoding utf8NoBOM

# Drop stale completed worktree roots from the last active multi-root window (best-effort)
foreach ($stale in @(
  'D:/01_Projects/Active/ai-pet.team-worktrees/T-020',
  'D:/01_Projects/Active/ai-pet.team-worktrees/T-021',
  'D:/01_Projects/Active/ai-pet.team-worktrees/integration'
)) {
  & cursor --remove $stale 2>$null | Out-Null
}

$cursorArgs = if ($NewWindow -or $Gui) { @('-n', $Workspace) } else { @('-r', $Workspace) }
Start-Process cursor -ArgumentList $cursorArgs | Out-Null
Write-Host "opened: $Workspace"
Write-Host 'sidebar: 1 folder — ai-pet (repo root)'
