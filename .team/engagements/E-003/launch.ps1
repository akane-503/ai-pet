# project-team-pm launch skeleton · E-003 → dsh
# Prints steps only; does not auto-start GUI.
$ErrorActionPreference = 'Continue'
Write-Host '=== engage launch E-003 (dsh) ==='
Write-Host 'cwd: D:\01_Projects\Active\ai-pet'
Write-Host 'brief: D:\01_Projects\Active\ai-pet\.team\engagements\E-003\BRIEF.md'
$brief = 'D:\01_Projects\Active\ai-pet\.team\engagements\E-003\BRIEF.md'
if (Test-Path -LiteralPath $brief) { Get-Content -LiteralPath $brief -TotalCount 15 | ForEach-Object { Write-Host $_ } }
Write-Host 'Next: open dsh with cwd above and paste BRIEF.md'
