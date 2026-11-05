<#
.SYNOPSIS
  Fully automatic team ops for ai-pet. No GUI by default.
#>
[CmdletBinding()]
param([switch]$Gui)

$ErrorActionPreference = 'Stop'
$Root = 'D:\01_Projects\Active\ai-pet'
$Team = Join-Path $Root '.team\tools\team.mjs'

Push-Location $Root
Write-Host '=== auto status ==='
node $Team status 2>&1 | Out-Host

foreach ($p in @(
  'D:\01_Projects\Active\ai-pet.team-worktrees\T-020',
  'D:\01_Projects\Active\ai-pet.team-worktrees\T-021',
  'D:\01_Projects\Active\ai-pet.team-worktrees\integration'
)) {
  if ((Test-Path $p) -and (Test-Path (Join-Path $p 'START_HERE.md'))) {
    Push-Location $p
    git ls-files --error-unmatch START_HERE.md 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Remove-Item -Force START_HERE.md -ErrorAction SilentlyContinue }
    Pop-Location
  }
}
$int = 'D:\01_Projects\Active\ai-pet.team-worktrees\integration'
if (Test-Path $int) {
  Push-Location $int
  if (git status --porcelain) { git stash push -u -m 'auto-clean integration' 2>&1 | Out-Null }
  Pop-Location
}

$boardPath = Join-Path $Root '.team\local\board.json'
if (Test-Path $boardPath) {
  $st = Get-Content -LiteralPath $boardPath -Raw -Encoding utf8 | ConvertFrom-Json
  foreach ($prop in $st.tasks.PSObject.Properties) {
    $task = $prop.Value
    if ($task.status -eq '待验收') {
      Write-Host "=== integrate $($task.id) ==="
      node $Team integrate --id $task.id 2>&1 | Out-Host
      node $Team accept --id $task.id 2>&1 | Out-Host
    } elseif ($task.status -eq '已集成') {
      node $Team accept --id $task.id 2>&1 | Out-Host
    }
  }
}

node $Team note --text '全自动：scripts/team-auto.ps1。GUI 窗口可忽略。' 2>&1 | Out-Host
node $Team status 2>&1 | Out-Host
node $Team doctor 2>&1 | Out-Host
Pop-Location

node -e "const fs=require('fs'); const pet='D:/01_Projects/Active/ai-pet'; fs.writeFileSync(pet+'/ai-pet-team.code-workspace', JSON.stringify({folders:[{name:'【1·Manager】管板',path:pet},{name:'【2】T-020 已完成',path:'D:/01_Projects/Active/ai-pet.team-worktrees/T-020'},{name:'【3】T-021 已完成',path:'D:/01_Projects/Active/ai-pet.team-worktrees/T-021'}],settings:{'window.title':'【ai-pet Team】已清板 · 无需点窗'}},null,2)+'\n','utf8');"

if ($Gui) { Start-Process cursor -ArgumentList @('-n', (Join-Path $Root 'ai-pet-team.code-workspace')) | Out-Null }
Write-Host '=== auto done ==='