# Stops the background Kainat server started by start.ps1.
$pidFile = "$PSScriptRoot\data\server.pid"
$ids = @()
if (Test-Path $pidFile) { $ids += [int](Get-Content $pidFile | Select-Object -First 1) }
# Also catch a server started by hand with `npm start` or `node server.js` from this folder.
$ids += Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'solar-procure[\\/]server\.js' -or $_.CommandLine -match '--disable-warning=ExperimentalWarning\s+server\.js\s*$' } |
  ForEach-Object { $_.ProcessId }
$stopped = 0
foreach ($id in ($ids | Select-Object -Unique)) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $id -Force; $stopped++; Write-Host "Stopped Kainat (PID $id)." }
}
Remove-Item -Force -ErrorAction SilentlyContinue $pidFile
if (-not $stopped) { Write-Host 'Kainat is not running.' }
