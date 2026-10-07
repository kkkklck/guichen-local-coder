param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('allow', 'deny')]
    [string]$Decision,
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$tempRoot = Join-Path $env:TEMP ('shell-approval-e2e-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$stdoutPath = Join-Path $tempRoot 'stdout.txt'
$stderrPath = Join-Path $tempRoot 'stderr.txt'
$client = Start-Process -FilePath $node -ArgumentList @('scripts/test-shell-approval-e2e.mjs', $Decision) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

$buttonText = if ($Decision -eq 'allow') { '允许一次' } else { '拒绝' }
$root = [System.Windows.Automation.AutomationElement]::RootElement
$windowCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    'Guichen Local Coder — Shell Guard 2.0'
)
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$clicked = $false
while ((Get-Date) -lt $deadline -and -not $client.HasExited -and -not $clicked) {
    try {
        $dialog = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $windowCondition)
        if ($dialog) {
            $buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::NameProperty,
                $buttonText
            )
            $button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
            if ($button) {
                $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                $clicked = $true
            }
        }
    } catch { }
    if (-not $clicked) { Start-Sleep -Milliseconds 200 }
}

if (-not $clicked) {
    throw "Could not locate and click the requested approval button; test client PID $($client.Id) remains available for cleanup."
}

$client.WaitForExit(30000) | Out-Null
if (-not $client.HasExited) { throw "MCP test client did not finish after clicking $Decision." }
$stdout = Get-Content -LiteralPath $stdoutPath -Raw
$stderr = Get-Content -LiteralPath $stderrPath -Raw
if ($stdout) { $stdout.Trim() }
if ($client.ExitCode -ne 0) {
    if ($stderr) { Write-Output $stderr.Trim() }
    throw "MCP end-to-end test exited with code $($client.ExitCode)."
}
$resolvedTempBase = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
if (-not $resolvedTempRoot.StartsWith($resolvedTempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to remove an e2e temporary directory outside the system temp folder.'
}
Remove-Item -LiteralPath $tempRoot -Recurse -Force
