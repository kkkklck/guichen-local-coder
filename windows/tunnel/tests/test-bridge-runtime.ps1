$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\bridge-runtime.ps1')
$script:passed = 0
function Assert([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw ('FAIL: ' + $Name) }
    $script:passed++
}
function Snapshot {
    return @'
{"live":true,"ready":true,"components":{"control-plane":{"status":"degraded","state":"polling","reason_code":"network_error","observed_at":"2026-10-06T00:00:00Z","details":{"consecutive_failures":9}},"dispatcher":{"details":{"active":0}},"queue":{"details":{"depth":0}},"response-delivery":{"details":{"in_progress":0}}}}
'@ | ConvertFrom-Json
}
foreach ($name in @('bridge-runtime.ps1','start-tunnel-autostart.ps1','run-local-coder-tunnel.ps1','start-local-coder-autostart.ps1','get-local-coder-status.ps1')) {
    $path = Join-Path $PSScriptRoot ('..\' + $name)
    $tokens = $null; $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
    Assert ($parseErrors.Count -eq 0) ('PowerShell syntax: ' + $name)
}
$h = Snapshot
Assert ((Get-BridgeConnectionState $h) -eq 'connection_failed') 'readyz alone never means connected'
Assert (Test-BridgeTunnelIdle $h) 'known idle fields accepted'
Assert ((Get-BridgeRecoveryAction $h $false $true 119) -eq 'wait') 'network failure retry threshold'
Assert ((Get-BridgeRecoveryAction $h $false $true 120) -eq 'restart_idle_transport') 'persistent idle network failure recovery'
Assert ((Get-BridgeRecoveryAction $h $true $true 14) -eq 'wait') 'proxy change debounced'
Assert ((Get-BridgeRecoveryAction $h $true $true 15) -eq 'restart_idle_transport') 'startup proxy race recovery'
Assert ((Get-BridgeRecoveryAction $h $true $false 500) -eq 'wait') 'unavailable route does not restart storm'
foreach ($pair in @(@('dispatcher','active'), @('queue','depth'), @('response-delivery','in_progress'))) {
    $h = Snapshot; $h.components.($pair[0]).details.($pair[1]) = 1
    Assert ((Get-BridgeRecoveryAction $h $true $true 500) -eq 'wait') ('do not restart busy ' + $pair[0])
}
$h = Snapshot; $h.components.queue.details = $null
Assert (-not (Test-BridgeTunnelIdle $h)) 'missing idle evidence fails closed'
Assert ((Get-BridgeRecoveryAction $h $true $true 500) -eq 'wait') 'missing idle evidence cannot trigger recovery'
foreach ($reason in @('rate_limited','http_429','authentication_error','http_401','permission_denied')) {
    $h = Snapshot; $h.components.'control-plane'.reason_code = $reason
    Assert ((Get-BridgeRecoveryAction $h $true $true 500) -eq 'wait') ('native rate/auth backoff preserved: ' + $reason)
}
$h = Snapshot; $h.components.'control-plane'.status = 'ok'
Assert ((Get-BridgeConnectionState $h) -eq 'connected') 'successful control-plane observation means connected'
Assert ((Get-BridgeRecoveryAction $h $true $true 500) -eq 'wait') 'healthy transport retained despite proxy change'
$h.components.'control-plane'.observed_at = $null
Assert ((Get-BridgeConnectionState $h) -eq 'connecting') 'no invented successful connection'
Assert ((Get-BridgeConnectionState $null) -eq 'not_running') 'absent snapshot handled'
$key = 'sk-' + ('a' * 32); $token = 'dummy-private-mcp-token'
$redacted = Protect-BridgeLogText ('error ' + $key + ' bearer other-private-value https://localhost/mcp/' + $token + ' token=hidden') @($key, $token)
Assert (-not $redacted.Contains($key) -and -not $redacted.Contains($token)) 'literal key and MCP token redacted'
Assert (-not $redacted.Contains('other-private-value') -and -not $redacted.Contains('token=hidden')) 'auth labels redacted'
Assert (-not $redacted.Contains('https://')) 'URLs excluded from persisted diagnostic strings'
# Mock Windows process APIs to prove recovery refuses unrelated/busy/reused
# process identities. These mocks cannot reach or stop a production process.
$originalSnapshotFunction = (Get-Item Function:\Get-BridgeTunnelSnapshot).ScriptBlock
$script:mockExe = $script:BridgeBinary
$script:mockOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:mockParent = ('powershell -File "' + (Join-Path $PSScriptRoot '..\start-tunnel-autostart.ps1' | Resolve-Path).Path + '"')
$script:mockCreation = Get-Date
$script:mockStart = $script:mockCreation
$script:mockSnapshot = Snapshot
$script:mockKills = 0
function Get-NetTCPConnection { param($State,$LocalPort); [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=424242} }
function Get-CimInstance {
    param($ClassName,$Filter)
    if ($Filter -match '424242') { [pscustomobject]@{ExecutablePath=$script:mockExe;ProcessId=424242;ParentProcessId=232323;CreationDate=$script:mockCreation} }
    else { [pscustomobject]@{CommandLine=$script:mockParent;CreationDate=$script:mockCreation.AddSeconds(-10)} }
}
function Invoke-CimMethod { param($InputObject,$MethodName); [pscustomobject]@{Sid=$script:mockOwner} }
function Get-BridgeTunnelSnapshot { return $script:mockSnapshot }
function Get-Process {
    param($Id)
    $p = [pscustomobject]@{Handle=[IntPtr]123;Path=$script:mockExe;StartTime=$script:mockStart}
    $p | Add-Member ScriptMethod Kill { $script:mockKills++ }
    $p | Add-Member ScriptMethod WaitForExit { param($Timeout); return $true }
    $p | Add-Member ScriptMethod Dispose { }
    return $p
}
function Assert-RecoveryRefused([string]$Name) {
    $refused = $false
    try { Stop-BridgeVerifiedTunnel } catch { $refused = $true }
    Assert ($refused -and $script:mockKills -eq 0) $Name
}
try {
    $script:mockExe = 'C:\Windows\System32\notepad.exe'
    Assert-RecoveryRefused 'foreign 8080 owner cannot be stopped'
    $script:mockExe = $script:BridgeBinary; $script:mockOwner = 'another-windows-user'
    Assert-RecoveryRefused 'another Windows user cannot be stopped'
    $script:mockOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $script:mockParent = 'powershell -File E:\unrelated\launch.ps1'
    Assert-RecoveryRefused 'untrusted startup parent cannot be stopped'
    $script:mockParent = ('powershell -File "' + (Join-Path $PSScriptRoot '..\start-tunnel-autostart.ps1' | Resolve-Path).Path + '"')
    $script:mockSnapshot.components.dispatcher.details.active = 1
    Assert-RecoveryRefused 'busy transport cannot be stopped'
    $script:mockSnapshot = Snapshot; $script:mockStart = $script:mockCreation.AddSeconds(5)
    Assert-RecoveryRefused 'reused or changed process identity cannot be stopped'
    $script:mockStart = $script:mockCreation
    Stop-BridgeVerifiedTunnel
    Assert ($script:mockKills -eq 1) 'verified idle disconnected identity is the only accepted recovery target'
} finally {
    foreach ($name in @('Get-NetTCPConnection','Get-CimInstance','Invoke-CimMethod','Get-Process')) { Remove-Item -LiteralPath ('Function:\' + $name) }
    Set-Item Function:\Get-BridgeTunnelSnapshot -Value $originalSnapshotFunction
}
$oldLogDir = $script:BridgeLogDir
$temporaryFile = [IO.Path]::GetTempFileName()
try {
    $script:BridgeLogDir = $temporaryFile
    Write-BridgeLog 'Synthetic disk/path failure test'
    Assert $true 'log storage errors cannot terminate the transport'
    Write-BridgeStatus 'test_state' 'test_route' $null
    Assert $true 'status storage errors cannot terminate the transport'
} finally {
    $script:BridgeLogDir = $oldLogDir
    Remove-Item -LiteralPath $temporaryFile
}
Write-Output ('PASS: ' + $script:passed + ' startup, connection, safe recovery and redaction assertions; no production process modified.')
