# Starts Kainat in the background on http://localhost:8090 and opens it in the browser.
# Usage: right-click > Run with PowerShell, or: powershell -ExecutionPolicy Bypass -File start.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = 'D:\DevEnv\tools\node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }
$port = 8090

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "Kainat is already running on http://localhost:$port"
} else {
  New-Item -ItemType Directory -Force -Path "$root\data" | Out-Null
  $p = Start-Process -FilePath $node -ArgumentList '--disable-warning=ExperimentalWarning', 'server.js' -WorkingDirectory $root `
    -WindowStyle Hidden -RedirectStandardOutput "$root\data\server.log" -RedirectStandardError "$root\data\server-error.log" -PassThru
  $p.Id | Out-File -Encoding ascii "$root\data\server.pid"
  Start-Sleep -Seconds 2
  Write-Host "Started Kainat (PID $($p.Id)) on http://localhost:$port"
}
Start-Process "http://localhost:$port"
