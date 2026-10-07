param([switch]$RepairExisting)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-runtime.ps1')
$mutex = New-Object System.Threading.Mutex($false, ('Local\GuichenLocalCoder.Tunnel.' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
$locked = $false; $child = $null; $runtimeKey = $null
try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { Write-Output 'Tunnel 启动守护程序已在运行；请使用 get-local-coder-status.ps1 查看实际连接状态。'; return }
    $config = Get-BridgeConfiguration
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue)
    if ($listeners.Count) {
        if (-not $RepairExisting) { Write-Output '8080 已有进程监听，未重复启动。请使用 get-local-coder-status.ps1 查看状态。'; return }
        Stop-BridgeVerifiedTunnel
        Write-BridgeLog 'Replaced a verified idle, disconnected transport; existing file server was retained.'
    }
    $runtimeKey = Get-BridgeRuntimeKey
    $failureSince = $null; $nextLaunch = [DateTime]::UtcNow; $restartDelay = 5
    $nextCheck = [DateTime]::MinValue; $nextRouteCheck = [DateTime]::MinValue
    $route = $null; $childRoute = ''; $routeReady = $false; $previousState = ''
    Write-BridgeLog 'Supervisor started; waiting for local server and current Windows network route.'
    while ($true) {
        $now = [DateTime]::UtcNow
        if ($child) {
            foreach ($streamName in @('stdout','stderr')) {
                $task = if ($streamName -eq 'stdout') { $stdout } else { $stderr }
                $reader = if ($streamName -eq 'stdout') { $child.StandardOutput } else { $child.StandardError }
                $count = 0
                while ($task -and $task.IsCompleted -and $count++ -lt 100) {
                    $line = $task.GetAwaiter().GetResult()
                    if ($null -eq $line) { $task = $null; break }
                    Read-BridgeNativeLog $line @($runtimeKey, $config.McpToken, $config.TunnelId)
                    $task = $reader.ReadLineAsync()
                }
                if ($streamName -eq 'stdout') { $stdout = $task } else { $stderr = $task }
            }
            if ($child.HasExited) {
                Write-BridgeLog ('Tunnel exited; code=' + $child.ExitCode + '; retry_seconds=' + $restartDelay)
                $child.Dispose(); $child = $null
                $nextLaunch = $now.AddSeconds($restartDelay); $restartDelay = [Math]::Min(120, $restartDelay * 2)
            }
        }
        if ($now -ge $nextCheck) {
            $snapshot = Get-BridgeTunnelSnapshot
            $state = Get-BridgeConnectionState $snapshot
            if ($child -and -not $snapshot) { $state = 'connecting' }
            if ($now -ge $nextRouteCheck) {
                $route = Get-BridgeProxyRoute
                $routeReady = if ($state -eq 'connected') { $true } else { Test-BridgeNetworkRoute $route }
                $nextRouteCheck = [DateTime]::UtcNow.AddSeconds(15)
            }
            if (-not $child) {
                if (-not (Test-BridgeLocalServer)) { $state = 'waiting_local_server' }
                elseif (-not $routeReady) { $state = 'waiting_network' }
                elseif ($now -ge $nextLaunch) {
                    if (Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue) { throw '8080 became occupied; no second tunnel was started.' }
                    $psi = New-Object System.Diagnostics.ProcessStartInfo
                    $psi.FileName = $script:BridgeBinary; $psi.WorkingDirectory = $PSScriptRoot
                    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
                    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
                    $psi.Arguments = 'run --log.format json --log.http-raw-unsafe=false --allow-remote-ui=false'
                    $psi.EnvironmentVariables['CONTROL_PLANE_TUNNEL_ID'] = $config.TunnelId
                    $psi.EnvironmentVariables['CONTROL_PLANE_API_KEY'] = $runtimeKey
                    $psi.EnvironmentVariables['CONTROL_PLANE_BASE_URL'] = 'https://api.openai.com'
                    $psi.EnvironmentVariables['MCP_SERVER_URL'] = 'http://127.0.0.1:3000/mcp/' + $config.McpToken
                    $psi.EnvironmentVariables['HEALTH_LISTEN_ADDR'] = '127.0.0.1:8080'
                    $psi.EnvironmentVariables['NO_PROXY'] = 'localhost,127.0.0.1,::1'
                    foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','LOCAL_CODER_CONTROL_PROXY')) { $psi.EnvironmentVariables.Remove($name) }
                    if ($route.Uri) {
                        $psi.EnvironmentVariables['LOCAL_CODER_CONTROL_PROXY'] = $route.Uri
                        $psi.Arguments += ' --control-plane.http-proxy env:LOCAL_CODER_CONTROL_PROXY'
                    }
                    $child = New-Object System.Diagnostics.Process; $child.StartInfo = $psi
                    if (-not $child.Start()) { throw 'Tunnel process could not start.' }
                    $stdout = $child.StandardOutput.ReadLineAsync(); $stderr = $child.StandardError.ReadLineAsync()
                    $childRoute = $route.Identity; $failureSince = [DateTime]::UtcNow; $state = 'connecting'
                    Write-BridgeLog ('Tunnel started with verified network route; route=' + $route.Kind)
                } else { $state = 'retry_backoff' }
            } elseif ($state -eq 'connected') {
                $failureSince = $null; $restartDelay = 5
            } else {
                if (-not $failureSince) { $failureSince = $now }
                $failedFor = ($now - $failureSince).TotalSeconds
                $action = Get-BridgeRecoveryAction $snapshot ($route.Identity -ne $childRoute) $routeReady $failedFor
                if ($action -eq 'restart_idle_transport') {
                    Stop-BridgeVerifiedTunnel
                    Write-BridgeLog 'Network failure persisted; verified idle transport stopped for bounded recovery.'
                    $nextLaunch = [DateTime]::UtcNow.AddSeconds(10)
                }
            }
            Write-BridgeStatus $state $route.Kind $snapshot
            if ($state -ne $previousState) { Write-BridgeLog ('Connection state=' + $state); $previousState = $state }
            $nextCheck = [DateTime]::UtcNow.AddSeconds(3)
        }
        Start-Sleep -Milliseconds 250
    }
} catch {
    Write-BridgeLog ('Supervisor stopped with error_type=' + $_.Exception.GetType().Name)
    Write-BridgeStatus 'supervisor_error' '' $null
    throw
} finally {
    if ($child) { if (-not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(5000) }; $child.Dispose() }
    $runtimeKey = $null
    if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose()
}
