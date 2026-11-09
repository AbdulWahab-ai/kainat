# Registers a Windows scheduled task that backs up Kainat every day at 21:00.
# If the PC is off at that time, the backup runs as soon as it is back on.
# Remove it with: Unregister-ScheduledTask -TaskName "Kainat daily backup" -Confirm:$false
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\DevEnv\tools\node\node.exe' }

$action = New-ScheduledTaskAction -Execute $node `
  -Argument "--disable-warning=ExperimentalWarning scripts\backup.js" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At 21:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'Kainat daily backup' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Backs up the Kainat database and uploads (scripts\backup.js).' -Force | Out-Null
Write-Output 'Scheduled "Kainat daily backup" for 21:00 every day.'
