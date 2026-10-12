param([switch]$InstallOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
try {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw 'Node.js is required. Install Node.js 22.12+ from https://nodejs.org/ and restart this launcher.'
    }
    $nodeVersion = [version]((& node.exe --version).Trim().TrimStart('v'))
    if ($nodeVersion -lt [version]'22.12.0') { throw "Node.js $nodeVersion is too old. Install Node.js 22.12+." }
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
    Push-Location -LiteralPath $root
    try {
        $ready = Test-Path -LiteralPath $exe
        if ($ready) {
            try {
                & node.exe -e "require('koffi'); const fs=require('fs'); const lock=require('./package-lock.json'); for(const name of ['electron','koffi']) if(JSON.parse(fs.readFileSync('node_modules/'+name+'/package.json','utf8')).version!==lock.packages['node_modules/'+name].version) process.exit(1)" 2>$null
                $ready = $LASTEXITCODE -eq 0
            } catch { $ready = $false }
        }
        if (-not $ready) {
            Write-Host 'First launch: downloading dependencies. Internet access is required...'
            & $npm ci --include=dev --include=optional --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your network, then run start.cmd again.' }
            # Electron 44 exposes an explicit installer rather than an npm postinstall script.
            if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
            & node.exe (Join-Path $root 'node_modules\electron\install.js')
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) { throw 'Electron download failed. Check your network and run start.cmd again.' }
            & node.exe -e "require('koffi')"
            if ($LASTEXITCODE -ne 0) { throw 'Native window integration is unavailable. Check Node.js architecture and reinstall dependencies.' }
        }
        if ($InstallOnly) { Write-Host 'Dependencies ready.'; exit 0 }
        Start-Process -FilePath $exe -ArgumentList ('"' + $root + '"') -WorkingDirectory $root -WindowStyle Hidden
    } finally { Pop-Location }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
