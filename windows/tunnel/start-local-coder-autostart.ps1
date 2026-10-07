$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$node = (Get-Command node.exe -ErrorAction Stop).Source
$mutex = New-Object System.Threading.Mutex($false, ('Local\GuichenLocalCoder.Server.' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
$locked = $false; $child = $null
try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { return }
    if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) { return }
    $retry = 5
    while ($true) {
        if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) { throw 'Local Coder port is occupied; no duplicate server was started.' }
        $child = Start-Process -FilePath $node -ArgumentList @('dist/index.js') -WorkingDirectory $project -WindowStyle Hidden -PassThru
        $started = Get-Date; $child.WaitForExit(); $exitCode = $child.ExitCode
        $child.Dispose(); $child = $null
        if (((Get-Date) - $started).TotalMinutes -gt 5) { $retry = 5 }
        $logDir = Join-Path $env:LOCALAPPDATA 'GuichenLocalCoder\logs'
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        Add-Content -LiteralPath (Join-Path $logDir 'server-autostart.log') -Value ((Get-Date -Format 's') + ' server_exit=' + $exitCode + ' retry_seconds=' + $retry) -Encoding UTF8
        Start-Sleep -Seconds $retry; $retry = [Math]::Min(120, $retry * 2)
    }
} finally {
    if ($child) { if (-not $child.HasExited) { $child.Kill() }; $child.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose()
}
