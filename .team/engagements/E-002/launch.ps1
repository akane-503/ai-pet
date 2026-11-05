# project-team-pm launch skeleton · E-002 → claude-code
# Prints steps only; does not auto-start GUI.
$ErrorActionPreference = 'Continue'
Write-Host '=== engage launch E-002 (claude-code) ==='
Write-Host 'cwd: D:\01_Projects\Active\ai-pet.team-worktrees\T-011'
Write-Host 'brief: D:\01_Projects\Active\ai-pet\.team\engagements\E-002\BRIEF.md'
$brief = 'D:\01_Projects\Active\ai-pet\.team\engagements\E-002\BRIEF.md'
if (Test-Path -LiteralPath $brief) { Get-Content -LiteralPath $brief -TotalCount 15 | ForEach-Object { Write-Host $_ } }
Write-Host 'Next: open claude-code with cwd above and paste BRIEF.md'
