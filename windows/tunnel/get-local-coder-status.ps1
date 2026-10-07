$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-runtime.ps1')
$localReady = Test-BridgeLocalServer
$snapshot = Get-BridgeTunnelSnapshot
$state = Get-BridgeConnectionState $snapshot
$labels = @{ connected='已连接，控制面轮询成功'; connecting='进程在运行，尚未确认连接';
    not_running='Tunnel 未运行或健康接口不可达'; connection_failed='进程在运行，控制面连接失败';
    rate_limited='控制面限流，正在等待重试'; authentication_error='控制面认证或权限错误' }
Write-Output ('Local Coder：' + $(if ($localReady) { ('正常，工作区 ' + $script:BridgeWorkspace) } else { '未就绪或安全边界检查未通过' }))
Write-Output ('Tunnel：' + $labels[$state])
if ($snapshot) {
    $c = $snapshot.components.'control-plane'
    Write-Output ('控制面状态：' + $c.status + ' / ' + $c.state + '；原因：' + $c.reason_code + '；连续失败：' + $c.details.consecutive_failures)
}
$statusPath = Join-Path $script:BridgeLogDir 'bridge-status.json'
if (Test-Path -LiteralPath $statusPath) {
    $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $stamp = if ($status.updated_at -is [DateTime]) { [DateTimeOffset]$status.updated_at } else { [DateTimeOffset]::Parse($status.updated_at) }
    $stale = if (([DateTimeOffset]::UtcNow - $stamp).TotalSeconds -gt 45) { '（记录已过期，以当前控制面检查为准）' } else { '' }
    Write-Output ('守护程序最近状态：' + $status.state + '；时间：' + $stamp.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss zzz') + $stale)
}
Write-Output '本机状态页面：http://127.0.0.1:8080/ui'
Write-Output ('安全日志：' + (Join-Path $script:BridgeLogDir 'tunnel-autostart.log'))
