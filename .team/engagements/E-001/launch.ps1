# project-team-pm launch skeleton · E-001 → codex
# Prints steps only; does not auto-start GUI.
$ErrorActionPreference = 'Continue'
Write-Host '=== engage launch E-001 (codex) ==='
Write-Host 'cwd: D:\01_Projects\Active\ai-pet.team-worktrees\T-010'
Write-Host 'brief: D:\01_Projects\Active\ai-pet\.team\engagements\E-001\BRIEF.md'
$brief = 'D:\01_Projects\Active\ai-pet\.team\engagements\E-001\BRIEF.md'
if (Test-Path -LiteralPath $brief) { Get-Content -LiteralPath $brief -TotalCount 15 | ForEach-Object { Write-Host $_ } }
Write-Host 'Next: open codex with cwd above and paste BRIEF.md'
