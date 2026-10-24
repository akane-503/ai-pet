# Installer "Test" button: exit 0 ok (prints balance), 2 rejected, 3 other HTTP error, 4 network, 5 not a key
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$k = $env:AIPET_KEY
if ($k -cnotmatch '^sk-[\x21-\x7e]+$') { exit 5 }
try {
  $r = Invoke-RestMethod -Uri 'https://api.deepseek.com/user/balance' -Headers @{ Authorization = "Bearer $k" } -TimeoutSec 10
  $b = $r.balance_infos | Select-Object -First 1
  if ($b) { Write-Output "$($b.total_balance) $($b.currency)" }
  exit 0
} catch {
  $s = $_.Exception.Response
  if ($s -and [int]$s.StatusCode -eq 401) { exit 2 }
  if ($s) { exit 3 }
  exit 4
}
