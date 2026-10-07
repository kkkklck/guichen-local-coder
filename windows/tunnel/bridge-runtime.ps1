# Shared transport/startup helpers. No MCP tool, Shell Guard or approval changes.
$script:BridgeProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:BridgeWorkspace = $null
$script:BridgeBinary = Join-Path $PSScriptRoot 'tunnel-client.exe'
$script:BridgeLogDir = Join-Path $env:LOCALAPPDATA 'GuichenLocalCoder\logs'

function Get-BridgeConfiguration {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath (Join-Path $script:BridgeProject '.env')) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
            $name = $Matches[1]
            if ($values.ContainsKey($name)) { throw 'Duplicate Local Coder setting.' }
            $values[$name] = $Matches[2].Trim().Trim('"').Trim("'")
        }
    }
    if ($values.HOST -ne '127.0.0.1' -or $values.PORT -ne '3000' -or
        $values.ADMIN_PORT -ne '3001' -or [string]::IsNullOrWhiteSpace($values.WORKSPACE_PATH) -or
        [string]::IsNullOrWhiteSpace($values.MCP_TOKEN)) { throw 'Local Coder boundary configuration check failed.' }
    $workspacePath = if ([IO.Path]::IsPathRooted($values.WORKSPACE_PATH)) { $values.WORKSPACE_PATH } else { Join-Path $script:BridgeProject $values.WORKSPACE_PATH }
    $script:BridgeWorkspace = [IO.Path]::GetFullPath($workspacePath)
    $workspaceInfo = Get-Item -LiteralPath $script:BridgeWorkspace -Force
    if (-not $workspaceInfo.PSIsContainer -or ($workspaceInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Workspace must be an ordinary directory.' }
    $settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'tunnel-settings.json') -Raw | ConvertFrom-Json
    if ($settings.tunnel_id -notmatch '^tunnel_[0-9a-f]{32}$') { throw 'Tunnel identifier configuration is invalid.' }
    if (-not (Test-Path -LiteralPath $script:BridgeBinary -PathType Leaf)) { throw 'Tunnel executable is missing.' }
    return [pscustomobject]@{ TunnelId = $settings.tunnel_id; McpToken = $values.MCP_TOKEN }
}

function Get-BridgeRuntimeKey {
    if (-not ('LocalCoderCredential' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LocalCoderCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {
  public UInt32 Flags, Type; public string TargetName, Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
  public UInt32 Persist, AttributeCount; public IntPtr Attributes;
  public string TargetAlias, UserName;
 }
 [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
 [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr credential);
 public static string Read(string target) {
  IntPtr ptr; if (!CredRead(target, 1, 0, out ptr)) throw new Exception("Credential Manager entry is unavailable.");
  try { var c=(CREDENTIAL)Marshal.PtrToStructure(ptr,typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2); }
  finally { CredFree(ptr); }
 }
}
'@
    }
    $key = [LocalCoderCredential]::Read('GuichenLocalCoder:RuntimeAPIKey')
    if ([string]::IsNullOrWhiteSpace($key)) { throw 'Runtime API credential is empty.' }
    return $key
}

function Get-BridgeProxyRoute {
    # Re-read Windows settings: DefaultWebProxy caches the startup snapshot.
    $target = [Uri]'https://api.openai.com'
    $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
    if ($systemProxy -and -not $systemProxy.IsBypassed($target)) {
        $uri = $systemProxy.GetProxy($target)
        if ($uri.Scheme -notin @('http', 'https')) { throw 'Unsupported system HTTP proxy scheme.' }
        return [pscustomobject]@{ Kind = 'system_proxy'; Uri = $uri.AbsoluteUri; Identity = $uri.AbsoluteUri }
    }
    return [pscustomobject]@{ Kind = 'direct'; Uri = $null; Identity = 'direct' }
}

function Test-BridgeNetworkRoute($Route) {
    # Anonymous TLS probe only; no credential sent. Successful polling is still
    # required before reporting connected. No raw response/body is logged.
    $request = [System.Net.HttpWebRequest]::Create('https://api.openai.com/v1/tunnels')
    $request.Method = 'GET'; $request.Timeout = 8000; $request.ReadWriteTimeout = 8000
    $request.AllowAutoRedirect = $false
    if ($Route.Uri) { $request.Proxy = New-Object System.Net.WebProxy($Route.Uri) } else { $request.Proxy = $null }
    $response = $null
    try { $response = $request.GetResponse() }
    catch [System.Net.WebException] { $response = $_.Exception.Response }
    try { return ($null -ne $response -and [int]$response.StatusCode -in @(200, 401)) }
    finally { if ($response) { $response.Close() }; $request.Abort() }
}

function Test-BridgeLocalServer {
    try {
        if (-not $script:BridgeWorkspace) { $null = Get-BridgeConfiguration }
        $h = Invoke-RestMethod 'http://127.0.0.1:3000/health' -TimeoutSec 3
        if ($h.status -ne 'ok' -or $h.workspace -ine $script:BridgeWorkspace -or $h.defaultCwd -ine $script:BridgeWorkspace -or
            $h.fullMachineAccess -ne $false -or $h.fullDiskAccess -ne $false) { return $false }
        foreach ($port in @(3000, 3001)) {
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
            if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') { return $false }
        }
        return $true
    } catch { return $false }
}

function Get-BridgeTunnelSnapshot {
    try { return Invoke-RestMethod 'http://127.0.0.1:8080/health?details=true' -TimeoutSec 3 } catch { return $null }
}

function Test-BridgeTunnelIdle($Snapshot) {
    if (-not $Snapshot -or -not $Snapshot.components) { return $false }
    foreach ($pair in @(@('dispatcher','active'), @('queue','depth'), @('response-delivery','in_progress'))) {
        $detail = $Snapshot.components.($pair[0]).details
        if (-not $detail -or -not $detail.PSObject.Properties[$pair[1]] -or $detail.($pair[1]) -ne 0) { return $false }
    }
    return $true
}

function Get-BridgeConnectionState($Snapshot) {
    if (-not $Snapshot) { return 'not_running' }
    $control = $Snapshot.components.'control-plane'
    if ($Snapshot.live -and $control.status -eq 'ok' -and $control.details.last_success) { return 'connected' }
    # Some client versions expose successful polling as status=ok without a
    # last_success field; observed_at must still be present.
    if ($Snapshot.live -and $control.status -eq 'ok' -and $control.observed_at) { return 'connected' }
    if ($control.reason_code -match 'rate|429') { return 'rate_limited' }
    if ($control.reason_code -match 'auth|401|403|permission') { return 'authentication_error' }
    if ($control.status -eq 'degraded') { return 'connection_failed' }
    return 'connecting'
}

function Get-BridgeRecoveryAction($Snapshot, [bool]$RouteChanged, [bool]$RouteReady, [double]$FailureSeconds) {
    $control = $Snapshot.components.'control-plane'
    if (-not $Snapshot -or -not $RouteReady -or -not (Test-BridgeTunnelIdle $Snapshot)) { return 'wait' }
    if ($control.status -ne 'degraded' -or $control.reason_code -notmatch '^(network_error|timeout|deadline_exceeded)$') { return 'wait' }
    if (($RouteChanged -and $FailureSeconds -ge 15) -or $FailureSeconds -ge 120) { return 'restart_idle_transport' }
    return 'wait'
}

function Stop-BridgeVerifiedTunnel {
    # Never stop arbitrary port owners, another user, a busy transport, or a
    # process whose executable/parent cannot be verified. Retain the OS handle.
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') { throw 'Tunnel listener cannot be safely identified.' }
    $info = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $listeners[0].OwningProcess)
    if ($info.ExecutablePath -ine $script:BridgeBinary) { throw '8080 belongs to another application.' }
    $owner = Invoke-CimMethod -InputObject $info -MethodName GetOwnerSid
    if ($owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Tunnel belongs to another Windows user.' }
    $parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $info.ParentProcessId)
    if (-not $parent -or $parent.CreationDate -gt $info.CreationDate -or
        $parent.CommandLine -notmatch ([Regex]::Escape($PSScriptRoot + '\') + '(?:start-tunnel-autostart|run-local-coder-tunnel)\.ps1(?:[" ]|$)')) {
        throw 'Tunnel was not launched by a known Local Coder startup script.'
    }
    $snapshot = Get-BridgeTunnelSnapshot
    if ((Get-BridgeConnectionState $snapshot) -ne 'connection_failed' -or -not (Test-BridgeTunnelIdle $snapshot)) {
        throw 'Existing tunnel is healthy, busy or cannot be verified; it was left running.'
    }
    $process = Get-Process -Id $info.ProcessId -ErrorAction Stop
    $null = $process.Handle
    if ($process.Path -ine $script:BridgeBinary -or [Math]::Abs(($process.StartTime - $info.CreationDate).TotalSeconds) -gt 1) {
        throw 'Tunnel process identity changed.'
    }
    $process.Kill(); $null = $process.WaitForExit(5000); $process.Dispose()
}

function Protect-BridgeLogText([string]$Text, [string[]]$Secrets) {
    foreach ($secret in $Secrets) { if ($secret) { $Text = $Text.Replace($secret, '[REDACTED]') } }
    $Text = $Text -replace 'sk-[A-Za-z0-9_-]{8,}', '[REDACTED]' -replace 'tunnel_[0-9a-f]{32}', '[TUNNEL_ID]'
    $Text = $Text -replace '(?i)(bearer\s+)[^\s,"'']+', '$1[REDACTED]'
    $Text = $Text -replace '(?i)((?:api[_ -]?key|token|secret|authorization|credential)\s*[:=]\s*)[^\s,;]+', '$1[REDACTED]'
    $Text = $Text -replace 'https?://[^\s]*', '[URL REDACTED]'
    return $Text
}

function Write-BridgeLog([string]$Message) {
    try {
    New-Item -ItemType Directory -Path $script:BridgeLogDir -Force | Out-Null
    $path = Join-Path $script:BridgeLogDir 'tunnel-autostart.log'
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 2MB) {
        for ($index = 2; $index -ge 1; $index--) {
            $source = "$path.$index"; if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination "$path.$($index+1)" -Force }
        }
        Move-Item -LiteralPath $path -Destination "$path.1" -Force
    }
    Add-Content -LiteralPath $path -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message) -Encoding UTF8
    } catch {
        Write-Warning 'Local Coder diagnostic log unavailable; transport retained.' -WarningAction Continue
    }
}

function Write-BridgeStatus([string]$State, [string]$Route, $Snapshot) {
    try {
    New-Item -ItemType Directory -Path $script:BridgeLogDir -Force | Out-Null
    $control = $null; if ($Snapshot) { $control = $Snapshot.components.'control-plane' }
    $value = [ordered]@{ updated_at = [DateTime]::UtcNow.ToString('o'); state = $State; route = $Route;
        reason_code = $control.reason_code; failures = $control.details.consecutive_failures }
    $path = Join-Path $script:BridgeLogDir 'bridge-status.json'
    $value | ConvertTo-Json | Set-Content -LiteralPath ($path + '.tmp') -Encoding UTF8
    Move-Item -LiteralPath ($path + '.tmp') -Destination $path -Force
    } catch {
        Write-Warning 'Local Coder status file unavailable; transport retained.' -WarningAction Continue
    }
}

function Read-BridgeNativeLog([string]$Line, [string[]]$Secrets) {
    try {
        $event = $Line | ConvertFrom-Json -ErrorAction Stop
        if ($event.level -in @('WARN','ERROR') -or $event.msg -like '*tunnel-client started*') {
            $message = '[' + $event.level + '] ' + $event.msg
            # Retain actionable errors/status/backoff, excluding IDs, URLs,
            # command payloads, headers and other uncontrolled attributes.
            foreach ($key in @('error','status','status_code','http_status','retry_in_ms','failure_category')) {
                if ($event.PSObject.Properties[$key]) { $message += ' ' + $key + '=' + [string]$event.$key }
            }
            Write-BridgeLog (Protect-BridgeLogText $message $Secrets)
        }
    } catch { Write-BridgeLog 'Native non-JSON diagnostic suppressed.' }
}
