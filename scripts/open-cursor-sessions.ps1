<#
.SYNOPSIS
  Default full-auto CLI. Pass -Gui only if you want one workspace window.
#>
[CmdletBinding()]
param([switch]$Gui)
& (Join-Path $PSScriptRoot 'team-auto.ps1') @PSBoundParameters