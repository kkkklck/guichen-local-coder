param([switch]$SelfTest, [string]$RequestId, [int]$PreviewDpi = 0)
$ErrorActionPreference = 'Stop'
$script:approvalStage = 'read_request'
$requestId = $RequestId
function Write-ApprovalEvent([string]$Stage, [string]$ErrorCategory = '', [string]$ErrorCode = '', [string]$ExceptionType = '', [int]$PayloadBytes = -1) {
    if ($requestId) {
        $event = @{ requestId = $requestId; stage = $Stage }
        if ($ErrorCategory) { $event.errorCategory = $ErrorCategory }
        if ($ErrorCode) { $event.errorCode = $ErrorCode }
        if ($ExceptionType) { $event.exceptionType = $ExceptionType }
        if ($PayloadBytes -ge 0) { $event.payloadBytes = $PayloadBytes }
        [Console]::Error.WriteLine(($event | ConvertTo-Json -Compress))
    }
}
try {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8, $false)
    $raw = $reader.ReadToEnd()
    Write-ApprovalEvent 'ipc_request_read' '' '' '' ([System.Text.Encoding]::UTF8.GetByteCount($raw))
    $script:approvalStage = 'parse_request'
    $request = $raw | ConvertFrom-Json -ErrorAction Stop
    $script:approvalStage = 'validate_request'
    if (-not $requestId) { $requestId = [string]$request.requestId }
    if ([string]$request.requestId -ne $requestId) { throw 'Approval request ID mismatch.' }
    if (-not $requestId -or -not $request.command -or -not $request.workingDirectory) { throw 'Invalid approval request.' }
    $script:approvalStage = 'create_window'
    . (Join-Path $PSScriptRoot 'shell-approval-ui.ps1')
    $script:approvalStage = 'show_dialog'
    [void]$form.ShowDialog()
    if ($script:approvalDecision -eq 'window_closed') { Write-ApprovalEvent 'window_closed' }
    $response = @{ requestId = $requestId; decision = $script:approvalDecision }
    if ($script:approvalErrorCategory) { $response.errorCategory = $script:approvalErrorCategory }
    $script:approvalStage = 'send_response'
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
    Write-ApprovalEvent 'result_sent'
    $form.Dispose()
    exit 0
}
catch {
    $category = switch ($script:approvalStage) {
        'read_request' { 'request_read_failed' }
        'parse_request' { 'request_parse_failed' }
        'validate_request' { 'request_validation_failed' }
        'send_response' { 'response_send_failed' }
        default { 'approval_window_failed' }
    }
    $decision = if ($script:approvalStage -in @('read_request', 'parse_request', 'validate_request', 'send_response')) { 'ipc_error' } else { 'window_error' }
    $errorCode = '0x' + $_.Exception.HResult.ToString('X8')
    $exceptionType = $_.Exception.GetType().FullName
    try { Write-ApprovalEvent $decision $category $errorCode $exceptionType } catch { }
    try { [Console]::Out.WriteLine((@{ requestId = $requestId; decision = $decision; errorCategory = $category; errorCode = $errorCode; exceptionType = $exceptionType } | ConvertTo-Json -Compress)) } catch { }
    exit 1
}
