# 创建桌面 / 开始菜单快捷方式（带图标），并可选设置开机自启
param([switch]$Autostart)
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root "node_modules\electron\dist\electron.exe"
$icon = Join-Path $root "assets\app.ico"
$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))) {
  $lnk = $ws.CreateShortcut((Join-Path $dir "AI 桌宠.lnk"))
  $lnk.TargetPath = $exe
  $lnk.Arguments = '"' + $root + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = $icon
  $lnk.Description = "AI 额度桌宠"
  $lnk.Save()
  Write-Host "已创建: $($lnk.FullName)"
}
if ($Autostart) {
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk = $ws.CreateShortcut((Join-Path $startup "AI 桌宠.lnk"))
  $lnk.TargetPath = $exe; $lnk.Arguments = '"' + $root + '"'; $lnk.WorkingDirectory = $root; $lnk.IconLocation = $icon; $lnk.Save()
  Write-Host "已加入开机自启: $($lnk.FullName)"
}
