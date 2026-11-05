<#
.SYNOPSIS
  One-click open ai-pet Manager + Executor (T-020/T-021) (+ optional Integration) sessions.

.DESCRIPTION
  - Ensures worktrees / START_HERE / prompts exist
  - Creates Cursor Agent CLI chats (agent create-chat) and seeds first message (-p)
  - Opens Cursor GUI windows focused on START_HERE.md
  - Prefills clipboard with Manager prompt

  Cannot inject text into the Cursor GUI chat composer; GUI still needs one Send
  (or @START_HERE.md). CLI chats are fully seeded and resumable.

.PARAMETER MultiRoot
  Open a single multi-root .code-workspace instead of separate windows.

.PARAMETER NoGui
  Skip opening Cursor GUI.

.PARAMETER NoSeed
  Create chat IDs only; do not send seed prompts via agent -p.

.PARAMETER RunExecutors
  After seed, run T-020/T-021 in print mode with --force (actually claim/write/submit).

.PARAMETER Integration
  Also open/seed the integration worktree session.

.PARAMETER WorkspaceOnly
  Only refresh materials + workspace file; do not open or seed.
#>
[CmdletBinding()]
param(
  [switch]$MultiRoot,
  [switch]$NoGui,
  [switch]$NoSeed,
  [switch]$RunExecutors,
  [switch]$Integration,
  [switch]$WorkspaceOnly
)

$ErrorActionPreference = 'Stop'
$Pet = 'D:\01_Projects\Active\ai-pet'
$ControlTeam = Join-Path $Pet '.team\tools\team.mjs'
$SessionsOut = Join-Path $Pet '.team\local\cursor-open\sessions.json'
$Gen = Join-Path $Pet 'scripts\_gen-cursor-open-materials.mjs'

function Ensure-Materials {
  if (-not (Test-Path $Gen)) { throw "Missing generator: $Gen" }
  node $Gen | Out-Host
  foreach ($id in @('T-020','T-021')) {
    $wt = "D:\01_Projects\Active\ai-pet.team-worktrees\$id"
    if (-not (Test-Path $wt)) {
      Write-Host "[open] dispatch $id"
      Push-Location $Pet
      node $ControlTeam dispatch --id $id | Out-Host
      Pop-Location
      node $Gen | Out-Host
    }
  }
}

function New-ChatId {
  $raw = & agent create-chat 2>&1 | Out-String
  $id = ($raw -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[0-9a-f-]{20,}$' } | Select-Object -First 1)
  if (-not $id) { throw "agent create-chat failed: $raw" }
  return $id
}

function Seed-Chat([string]$ChatId, [string]$Workspace, [string]$Prompt, [string]$Mode = 'ask') {
  Write-Host "[seed] $ChatId @ $Workspace ($Mode)"
  $args = @('--workspace', $Workspace, '--trust', '--mode', $Mode, '-p', '--resume', $ChatId, $Prompt)
  & agent @args 2>&1 | Select-Object -First 25 | ForEach-Object { Write-Host "  $_" }
}

function Open-Gui([string]$Folder, [string]$StartHere) {
  $start = Join-Path $Folder 'START_HERE.md'
  if (-not (Test-Path $start)) { $start = $StartHere }
  Write-Host "[gui] $Folder"
  # Separate classic window + jump to START_HERE (Agent panel: user @ file / paste)
  Start-Process -FilePath 'cursor' -ArgumentList @('-n', '-g', "${start}:1") | Out-Null
  Start-Sleep -Milliseconds 800
}

Ensure-Materials
if ($WorkspaceOnly) {
  Write-Host '[open] materials refreshed only'
  exit 0
}

$roles = @(
  @{ Name = 'manager'; Folder = $Pet; PromptFile = Join-Path $Pet '.team\local\cursor-open\manager.prompt.txt'; Mode = 'agent' },
  @{ Name = 'T-020'; Folder = 'D:\01_Projects\Active\ai-pet.team-worktrees\T-020'; PromptFile = Join-Path $Pet '.team\local\cursor-open\T-020.prompt.txt'; Mode = 'ask' },
  @{ Name = 'T-021'; Folder = 'D:\01_Projects\Active\ai-pet.team-worktrees\T-021'; PromptFile = Join-Path $Pet '.team\local\cursor-open\T-021.prompt.txt'; Mode = 'ask' }
)
if ($Integration) {
  $roles += @{ Name = 'integration'; Folder = 'D:\01_Projects\Active\ai-pet.team-worktrees\integration'; PromptFile = Join-Path $Pet '.team\local\cursor-open\integration.prompt.txt'; Mode = 'agent' }
}

$record = [ordered]@{
  at = (Get-Date).ToString('o')
  pet = $Pet
  chats = @()
}

foreach ($r in $roles) {
  $prompt = Get-Content -LiteralPath $r.PromptFile -Raw -Encoding utf8
  $chatId = New-ChatId
  Write-Host "[chat] $($r.Name) = $chatId"
  if (-not $NoSeed) {
    Seed-Chat -ChatId $chatId -Workspace $r.Folder -Prompt $prompt.Trim() -Mode $r.Mode
  }
  if ($RunExecutors -and $r.Name -match '^T-') {
    Write-Host "[run] executor $($r.Name) with --force"
    $runPrompt = @"
按 START_HERE.md 与 .team 简报完成 $($r.Name)：在本 worktree claim（用简报 token），只改写集文件并 git commit，然后 submit。
控制面：node $Pet/.team/tools/team.mjs
不要改 src/**，不要 push。
"@
    & agent --workspace $r.Folder --trust --force -p --resume $chatId $runPrompt 2>&1 | Select-Object -First 40 | ForEach-Object { Write-Host "  $_" }
  }
  $record.chats += [ordered]@{
    role = $r.Name
    chatId = $chatId
    workspace = $r.Folder
    resume = "agent --workspace `"$($r.Folder)`" --resume $chatId"
  }
}

$json = $record | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($SessionsOut, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "[open] wrote $SessionsOut"

# Clipboard = Manager prompt
try {
  $mgr = Get-Content -LiteralPath (Join-Path $Pet '.team\local\cursor-open\manager.prompt.txt') -Raw -Encoding utf8
  Set-Clipboard -Value $mgr.Trim()
  Write-Host '[open] clipboard = Manager prompt'
} catch {
  Write-Host "[open] clipboard skipped: $($_.Exception.Message)"
}

if (-not $NoGui) {
  if ($MultiRoot) {
    $ws = Join-Path $Pet 'ai-pet-team.code-workspace'
    Write-Host "[gui] multi-root $ws"
    Start-Process -FilePath 'cursor' -ArgumentList @('-n', $ws) | Out-Null
  } else {
    foreach ($r in $roles) { Open-Gui -Folder $r.Folder -StartHere (Join-Path $r.Folder 'START_HERE.md') }
  }
}

Write-Host ''
Write-Host '=== done ==='
Write-Host "Chats: $SessionsOut"
Write-Host 'GUI: each window opens START_HERE.md — in Agent 输入框 Ctrl+V（Manager 已在剪贴板）或 @START_HERE.md 后发送一次。'
Write-Host 'CLI resume 示例:'
foreach ($c in $record.chats) { Write-Host "  $($c.resume)" }