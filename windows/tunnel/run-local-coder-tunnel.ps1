param([switch]$Configure, [switch]$StatusOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-runtime.ps1')
if ($StatusOnly) { & (Join-Path $PSScriptRoot 'get-local-coder-status.ps1'); return }
if ($Configure) {
    $id = (Read-Host 'OpenAI Secure MCP Tunnel ID').Trim()
    if ($id -notmatch '^tunnel_[0-9a-f]{32}$') { throw 'Tunnel ID format is invalid.' }
    & (Join-Path $PSScriptRoot 'save-runtime-credential.ps1')
    @{ tunnel_id = $id } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'tunnel-settings.json') -Encoding UTF8
    Write-Output '设置已保存。正在运行的连接不会被静默更换。'
}
$snapshot = Get-BridgeTunnelSnapshot
if ((Get-BridgeConnectionState $snapshot) -eq 'connected') {
    & (Join-Path $PSScriptRoot 'get-local-coder-status.ps1')
    Write-Output '已连接，使用现有 Tunnel；未启动第二个实例。'
    return
}
Write-Output '正在启动连接守护程序；仅使用已保存的 Tunnel 与 Windows 凭据。'
& (Join-Path $PSScriptRoot 'start-tunnel-autostart.ps1') -RepairExisting
