<#
.SYNOPSIS
  Open named Cursor sessions for ai-pet (window titles you can read).

.PARAMETER Gui
  Open named .code-workspace windows (default: on).

.PARAMETER Named
  Refresh named workspaces / SESSION_MAP (always done).

.PARAMETER Seed
  Also create Agent CLI chats and seed first message.

.PARAMETER RunExecutors
  With -Seed, actually claim/write/submit T-020/T-021 via agent --force.

.PARAMETER Integration
  Include Integration window.

.PARAMETER NoGui
  Skip opening windows.
#>
[CmdletBinding()]
param(
  [switch]$Gui = $true,
  [switch]$NoGui,
  [switch]$Seed,
  [switch]$RunExecutors,
  [switch]$Integration,
  [switch]$WorkspaceOnly
)

$ErrorActionPreference = 'Stop'
$Pet = 'D:\01_Projects\Active\ai-pet'
$ControlTeam = Join-Path $Pet '.team\tools\team.mjs'
$SessDir = Join-Path $Pet '.team\cursor-sessions'
$SessionsOut = Join-Path $Pet '.team\local\cursor-open\sessions.json'
$GenNamed = Join-Path $Pet 'scripts\_gen-named-sessions.mjs'
$GenMats = Join-Path $Pet 'scripts\_gen-cursor-open-materials.mjs'

if ($NoGui) { $Gui = $false }

function Get-Roles {
  $path = Join-Path $SessDir 'roles.json'
  if (-not (Test-Path $path)) { throw "missing $path — run generator" }
  return Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json
}

Write-Host '[1] refresh named workspaces + START_HERE + SESSION_MAP'
if (Test-Path $GenMats) { node $GenMats | Out-Null }
node $GenNamed | Out-Host
if ($WorkspaceOnly) { exit 0 }

$roles = @(Get-Roles)
if (-not $Integration) { $roles = @($roles | Where-Object { $_.key -ne 'integration' }) }

$record = [ordered]@{
  at = (Get-Date).ToString('o')
  pet = $Pet
  chats = @()
}

if ($Seed) {
  Write-Host '[2] create + seed named Agent CLI chats'
  foreach ($r in $roles) {
    $raw = & agent create-chat 2>&1 | Out-String
    $chatId = ($raw -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[0-9a-f-]{20,}$' } | Select-Object -First 1)
    if (-not $chatId) { throw "create-chat failed for $($r.key): $raw" }
    $prompt = "你是「$($r.windowTitle)」。职责：$($r.job)。任务：$($r.task)。先读本工作区 START_HERE.md 与 SESSION_MAP.md，用中文确认你的角色名与下一步。不要改无关文件。"
    $force = $false
    if ($RunExecutors -and $r.key -match '^T-') {
      $force = $true
      $prompt = "你是「$($r.windowTitle)」。立即按 START_HERE.md 与 sessions 简报完成 $($r.key)：claim→只改写集→commit→submit。控制面 node $Pet\.team\tools\team.mjs。不要 push。"
    }
    Write-Host "  [$($r.windowTitle)] chat=$chatId"
    $argv = @('--workspace', $r.folder, '--trust', '-p', '--resume', $chatId)
    if ($force) { $argv = @('--workspace', $r.folder, '--trust', '--force', '-p', '--resume', $chatId) }
    $argv += $prompt
    & agent @argv 2>&1 | Select-Object -First 15 | ForEach-Object { Write-Host "    $_" }

    if ($r.key -match '^T-') {
      Push-Location $Pet
      node $ControlTeam link --id $r.key --session $chatId --name $r.windowTitle 2>&1 | Out-Host
      Pop-Location
    }

    $record.chats += [ordered]@{
      role = $r.key
      name = $r.windowTitle
      job = $r.job
      task = $r.task
      chatId = $chatId
      workspaceFile = Join-Path $SessDir $r.file
      folder = $r.folder
      resume = "agent --workspace `"$($r.folder)`" --resume $chatId"
    }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $SessionsOut) | Out-Null
  [IO.File]::WriteAllText($SessionsOut, ($record | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
} else {
  Write-Host '[2] skip CLI seed (pass -Seed to create chats). Still opening named GUI windows.'
}

if ($Gui) {
  Write-Host '[3] open named Cursor windows (title bar = 角色名)'
  foreach ($r in $roles) {
    $ws = Join-Path $SessDir $r.file
    Write-Host "  open $($r.windowTitle) <- $ws"
    Start-Process -FilePath 'cursor' -ArgumentList @('-n', $ws) | Out-Null
    Start-Sleep -Milliseconds 900
  }
}

Push-Location $Pet
node $ControlTeam note --text "命名会话：见 SESSION_MAP.md / .team/cursor-sessions/。窗口标题【Manager】【Exec·T-020】【Exec·T-021】【Integration】。" 2>&1 | Out-Host
node $ControlTeam status 2>&1 | Out-Host
Pop-Location

Write-Host ''
Write-Host '=== 命名会话已打开 ==='
Write-Host '看标题栏 / 侧栏根名即可分辨。一览：SESSION_MAP.md'
Get-Content (Join-Path $Pet 'SESSION_MAP.md') -Encoding utf8 | Select-Object -First 20