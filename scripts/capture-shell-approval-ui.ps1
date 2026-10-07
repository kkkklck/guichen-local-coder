param(
    [ValidateSet(96, 120, 144, 192)]
    [int]$PreviewDpi = 96,
    [string]$OutputPath = '',
    [string]$CommandText = 'python -c "print(''APPROVAL_OK'')"',
    [string]$PurposeText = '验证 Windows Shell 审批和命令执行功能，仅向控制台打印测试文字，不修改文件。',
    [ValidateSet('medium', 'high')]
    [string]$Risk = 'medium',
    [ValidateSet('close', 'esc', 'enter')]
    [string]$Action = 'close'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputPath) {
    $OutputPath = Join-Path $repoRoot ('artifacts\shell-guard-2.0\preview-' + [int]($PreviewDpi / 96 * 100) + 'pct.png')
}
$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$requestId = [Guid]::NewGuid().ToString()
$request = @{
    requestId = $requestId
    command = $CommandText
    workingDirectory = 'E:\gptonline'
    purpose = $PurposeText
    risk = $Risk
    reasons = @(
        'This command is not on the narrow automatic allowlist.',
        'It invokes a runtime, package manager, build tool, or Git, which can execute project or configured code.'
    )
}
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$dialogScript = Join-Path $repoRoot 'scripts\shell-approval-dialog.ps1'
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $powershellExe
$start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "' + $dialogScript + '" -RequestId ' + $requestId + ' -PreviewDpi ' + $PreviewDpi
$start.WorkingDirectory = $repoRoot
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
$process = [System.Diagnostics.Process]::Start($start)
$process.StandardInput.Write(($request | ConvertTo-Json -Compress -Depth 6))
$process.StandardInput.Close()
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'Guichen Local Coder — Shell Guard 2.0'
)
$dialog = $null
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and -not $process.HasExited -and -not $dialog) {
    $dialog = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
    if (-not $dialog) { Start-Sleep -Milliseconds 150 }
}
if (-not $dialog) {
    $process.WaitForExit(2000) | Out-Null
    $responseText = $process.StandardOutput.ReadToEnd()
    try {
        $failure = $responseText | ConvertFrom-Json -ErrorAction Stop
        throw "Approval UI did not appear: $($failure.decision), $($failure.errorCategory), $($failure.exceptionType), $($failure.errorCode)."
    } catch [System.Management.Automation.RuntimeException] { throw }
    catch { throw "Approval UI did not appear for preview DPI $PreviewDpi (exit $($process.ExitCode))." }
}
Start-Sleep -Milliseconds 250
$rect = $dialog.Current.BoundingRectangle
$width = [int][Math]::Ceiling($rect.Width)
$height = [int][Math]::Ceiling($rect.Height)
if ($width -lt 300 -or $height -lt 300) { throw 'Approval UI bounds were unexpectedly small.' }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen([int]$rect.Left, [int]$rect.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
$closePattern = $dialog.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
if ($Action -eq 'close') {
    $closePattern.Close()
} else {
    Add-Type -AssemblyName System.Windows.Forms
    if ($Action -eq 'enter') {
        $allowCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty, '允许一次'
        )
        $allowButton = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $allowCondition)
        if (-not $allowButton) { throw 'Allow button was not found for Enter-key safety test.' }
        $allowButton.SetFocus()
    } else {
        $denyCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty, '拒绝'
        )
        $denyButton = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $denyCondition)
        if (-not $denyButton) { throw 'Deny button was not found for Esc-key safety test.' }
        $denyButton.SetFocus()
    }
    [System.Windows.Forms.SendKeys]::SendWait($(if ($Action -eq 'esc') { '{ESC}' } else { '{ENTER}' }))
    if ($Action -eq 'enter') {
        Start-Sleep -Milliseconds 700
        if ($process.HasExited) { throw 'Enter key unexpectedly closed the approval window.' }
        $closePattern.Close()
    }
}
if (-not $process.WaitForExit(10000)) { throw 'Preview approval process did not exit after the window was closed.' }
$response = $process.StandardOutput.ReadToEnd() | ConvertFrom-Json
$previewMetrics = ($process.StandardError.ReadToEnd() -split "`r?`n" | Where-Object { $_ -like 'PREVIEW_METRICS*' } | Select-Object -First 1)
if ($response.requestId -ne $requestId -or $response.decision -ne $(if ($Action -eq 'esc') { 'denied' } else { 'window_closed' })) { throw "Preview action $Action returned decision $($response.decision), not the expected deny decision." }
[pscustomobject]@{ path = $OutputPath; width = $width; height = $height; preview_dpi = $PreviewDpi; layout = $previewMetrics; decision = $response.decision } | ConvertTo-Json -Compress
