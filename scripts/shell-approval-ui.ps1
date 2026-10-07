# UI only. The parent script owns the request/response protocol and the decision.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GuichenDpiAwareness {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDPIAware();
}
'@
if (-not [GuichenDpiAwareness]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
    [void][GuichenDpiAwareness]::SetProcessDPIAware()
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
public static class GuichenUiShape {
    public static GraphicsPath Rounded(Rectangle rect, int radius) {
        int d = Math.Min(Math.Min(rect.Width, rect.Height), Math.Max(2, radius * 2));
        var path = new GraphicsPath();
        path.AddArc(rect.Left, rect.Top, d, d, 180, 90);
        path.AddArc(rect.Right - d, rect.Top, d, d, 270, 90);
        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        path.AddArc(rect.Left, rect.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}
public class GuichenCard : Panel {
    public Color FillColor { get; set; }
    public Color LineColor { get; set; }
    public int Radius { get; set; }
    public GuichenCard() { DoubleBuffered = true; FillColor = Color.White; LineColor = Color.LightGray; Radius = 10; }
    protected override void OnPaintBackground(PaintEventArgs e) {
        using (var b = new SolidBrush(Parent == null ? FillColor : Parent.BackColor)) e.Graphics.FillRectangle(b, ClientRectangle);
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
        using (var path = GuichenUiShape.Rounded(rect, Radius)) {
            using (var fill = new SolidBrush(FillColor)) e.Graphics.FillPath(fill, path);
            using (var pen = new Pen(LineColor, 1)) e.Graphics.DrawPath(pen, path);
        }
    }
}
public class GuichenButton : Button {
    public Color FillColor { get; set; }
    public Color LineColor { get; set; }
    public int Radius { get; set; }
    public bool IgnoreEnter { get; set; }
    public GuichenButton() { FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; FillColor = Color.White; LineColor = Color.LightGray; Radius = 8; }
    protected override bool ProcessDialogKey(Keys keyData) {
        if (IgnoreEnter && (keyData & Keys.KeyCode) == Keys.Enter) return true;
        return base.ProcessDialogKey(keyData);
    }
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var back = new SolidBrush(Parent == null ? Color.White : Parent.BackColor)) e.Graphics.FillRectangle(back, ClientRectangle);
        var rect = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
        using (var path = GuichenUiShape.Rounded(rect, Radius)) {
            using (var fill = new SolidBrush(Enabled ? FillColor : Color.FromArgb(226, 230, 236))) e.Graphics.FillPath(fill, path);
            using (var pen = new Pen(LineColor, 1)) e.Graphics.DrawPath(pen, path);
        }
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle,
            Enabled ? ForeColor : Color.FromArgb(120, 130, 145),
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
}
public class GuichenShield : Control {
    public GuichenShield() { DoubleBuffered = true; }
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
        using (var path = GuichenUiShape.Rounded(rect, Math.Max(8, Width / 4)))
        using (var fill = new SolidBrush(Color.FromArgb(232, 240, 255))) e.Graphics.FillPath(fill, path);
        float s = Math.Min(Width, Height) / 52f;
        var points = new PointF[] {
            new PointF(26*s, 10*s), new PointF(37*s, 15*s), new PointF(36*s, 30*s),
            new PointF(33*s, 36*s), new PointF(26*s, 41*s), new PointF(19*s, 36*s),
            new PointF(16*s, 30*s), new PointF(15*s, 15*s)
        };
        using (var pen = new Pen(Color.FromArgb(37, 99, 235), Math.Max(2, 2*s))) {
            pen.LineJoin = LineJoin.Round;
            e.Graphics.DrawPolygon(pen, points);
            e.Graphics.DrawLines(pen, new PointF[] { new PointF(21*s, 23*s), new PointF(25*s, 26*s), new PointF(21*s, 29*s) });
            e.Graphics.DrawLine(pen, 27*s, 30*s, 32*s, 30*s);
        }
    }
}
public static class LocalCoderApprovalWindow {
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
'@ -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing')

[System.Windows.Forms.Application]::EnableVisualStyles()
$systemGraphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$systemDpi = [single]$systemGraphics.DpiX
$systemGraphics.Dispose()
$designDpi = if ($PreviewDpi -gt 0) { [single]$PreviewDpi } else { $systemDpi }
$uiScale = $designDpi / 96.0
$fontScale = $designDpi / $systemDpi
function UiPx([double]$value) { return [int][Math]::Round($value * $uiScale) }
function UiColor([string]$value) { return [System.Drawing.ColorTranslator]::FromHtml($value) }
function UiMultiline([string]$value) { return ($value -replace "`r`n|`n|`r", [Environment]::NewLine) }
$installedFamilies = @((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name })
$uiFamily = if ($installedFamilies -contains 'Segoe UI Variable') { 'Segoe UI Variable' } elseif ($installedFamilies -contains 'Microsoft YaHei UI') { 'Microsoft YaHei UI' } else { 'Segoe UI' }
$codeFamily = if ($installedFamilies -contains 'Cascadia Code') { 'Cascadia Code' } else { 'Consolas' }
function UiFont([single]$points, [bool]$bold = $false, [string]$family = $uiFamily) {
    $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    return New-Object System.Drawing.Font($family, [single]($points * $fontScale), $style)
}
$surface = UiColor '#F6F7F9'
$white = UiColor '#FFFFFF'
$line = UiColor '#E3E7ED'
$ink = UiColor '#18212F'
$muted = UiColor '#697586'
$blue = UiColor '#2563EB'
$codeBack = UiColor '#1B2332'
$codeText = UiColor '#C8F4D8'
$highRisk = [string]$request.risk -eq 'high'
$riskBack = if ($highRisk) { UiColor '#FFF0F0' } else { UiColor '#FFF7E9' }
$riskInk = if ($highRisk) { UiColor '#B42318' } else { UiColor '#854D0E' }
$riskLine = if ($highRisk) { UiColor '#F9C9C9' } else { UiColor '#F4D9AA' }
$riskText = if ($highRisk) { '高风险' } else { '中等风险' }

$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$maxArea = [double]$work.Width * [double]$work.Height * 0.235
$targetWidth = [int][Math]::Min((UiPx 760), [Math]::Min(($work.Width * 0.52), [Math]::Sqrt($maxArea * 1.45)))
$targetHeight = [int][Math]::Min((UiPx 660), [Math]::Min(($work.Height * 0.90), [Math]::Floor($maxArea / $targetWidth)))
if ($PreviewDpi) { [Console]::Error.WriteLine("PREVIEW_METRICS preview=$PreviewDpi design=$designDpi target=${targetWidth}x${targetHeight}") }
$script:approvalDecision = 'window_closed'
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Guichen Local Coder — Shell Guard 2.0'
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.Size = New-Object System.Drawing.Size($targetWidth, $targetHeight)
$form.MinimumSize = New-Object System.Drawing.Size([int][Math]::Min((UiPx 680), ($targetWidth * 0.88)), [int][Math]::Min((UiPx 500), ($targetHeight * 0.82)))
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.ShowIcon = $false
$form.BackColor = $surface
$form.Font = UiFont 10
$form.Padding = New-Object System.Windows.Forms.Padding((UiPx 22))
$form.KeyPreview = $true

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = 'Fill'
$root.BackColor = $surface
$root.ColumnCount = 1
$root.RowCount = 3
[void]$root.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, (UiPx 70))))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, (UiPx 90))))
[void]$form.Controls.Add($root)

$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Fill'
$header.BackColor = $surface
$shield = New-Object GuichenShield
$shield.Size = New-Object System.Drawing.Size((UiPx 52), (UiPx 52))
$shield.Location = New-Object System.Drawing.Point(0, (UiPx 3))
[void]$header.Controls.Add($shield)
$headerTitle = New-Object System.Windows.Forms.Label
$headerTitle.Text = 'Shell 执行请求'
$headerTitle.Font = UiFont 16.5 $true
$headerTitle.ForeColor = $ink
$headerTitle.Location = New-Object System.Drawing.Point((UiPx 68), 0)
$headerTitle.Height = UiPx 36
$headerTitle.TextAlign = 'MiddleLeft'
[void]$header.Controls.Add($headerTitle)
$headerSubtitle = New-Object System.Windows.Forms.Label
$headerSubtitle.Text = 'ChatGPT 请求在你的电脑上执行一条命令'
$headerSubtitle.Font = UiFont 9.5
$headerSubtitle.ForeColor = $muted
$headerSubtitle.Location = New-Object System.Drawing.Point((UiPx 68), (UiPx 34))
$headerSubtitle.Height = UiPx 26
$headerSubtitle.TextAlign = 'MiddleLeft'
[void]$header.Controls.Add($headerSubtitle)
$riskBadge = New-Object GuichenCard
$riskBadge.FillColor = $riskBack
$riskBadge.LineColor = $riskBack
$riskBadge.Radius = UiPx 13
$riskBadge.Padding = New-Object System.Windows.Forms.Padding((UiPx 2))
$riskBadge.Size = New-Object System.Drawing.Size((UiPx 88), (UiPx 27))
$riskBadge.Top = UiPx 8
$riskBadgeLabel = New-Object System.Windows.Forms.Label
$riskBadgeLabel.Text = $riskText
$riskBadgeLabel.Dock = 'Fill'
$riskBadgeLabel.TextAlign = 'MiddleCenter'
$riskBadgeLabel.Font = UiFont 9
$riskBadgeLabel.ForeColor = $riskInk
$riskBadgeLabel.BackColor = $riskBack
[void]$riskBadge.Controls.Add($riskBadgeLabel)
[void]$header.Controls.Add($riskBadge)
$headerLine = New-Object System.Windows.Forms.Panel
$headerLine.Height = 1
$headerLine.BackColor = $line
$headerLine.Dock = 'Bottom'
[void]$header.Controls.Add($headerLine)
$header.Add_Resize({
    $riskBadge.Left = [Math]::Max(0, $header.ClientSize.Width - $riskBadge.Width)
    $headerTitle.Width = [Math]::Max(80, $riskBadge.Left - $headerTitle.Left - (UiPx 10))
    $headerSubtitle.Width = [Math]::Max(80, $header.ClientSize.Width - $headerSubtitle.Left)
})
[void]$root.Controls.Add($header, 0, 0)

$bodyScroll = New-Object System.Windows.Forms.Panel
$bodyScroll.Dock = 'Fill'
$bodyScroll.AutoScroll = $true
$bodyScroll.BackColor = $surface
[void]$root.Controls.Add($bodyScroll, 0, 1)
$body = New-Object System.Windows.Forms.TableLayoutPanel
$body.ColumnCount = 1
$body.RowCount = 8
$body.BackColor = $surface
$body.Margin = New-Object System.Windows.Forms.Padding(0)
[void]$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
foreach ($height in @(58, 8, 26, 84, 10, 94, 10, 100)) {
    [void]$body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, (UiPx $height))))
}
$body.Size = New-Object System.Drawing.Size(300, (UiPx 390))
[void]$bodyScroll.Controls.Add($body)
$bodyScroll.Add_Resize({ $body.Width = [Math]::Max(200, $bodyScroll.ClientSize.Width - (UiPx 2)) })

$summary = New-Object GuichenCard
$summary.Dock = 'Fill'
$summary.Margin = New-Object System.Windows.Forms.Padding(0)
$summary.FillColor = $white
$summary.LineColor = $line
$summary.Radius = UiPx 11
$summary.BackColor = $white
$summary.Padding = New-Object System.Windows.Forms.Padding((UiPx 2))
$summaryTable = New-Object System.Windows.Forms.TableLayoutPanel
$summaryTable.Dock = 'Fill'
$summaryTable.BackColor = $white
$summaryTable.Padding = New-Object System.Windows.Forms.Padding((UiPx 13), (UiPx 8), (UiPx 13), (UiPx 7))
$summaryTable.ColumnCount = 2
$summaryTable.RowCount = 2
[void]$summaryTable.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 54)))
[void]$summaryTable.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 46)))
[void]$summaryTable.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 44)))
[void]$summaryTable.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 56)))
function SummaryLabel([string]$text, [bool]$strong = $false) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $text
    $label.Dock = 'Fill'
    $label.Margin = New-Object System.Windows.Forms.Padding(0)
    $label.TextAlign = 'MiddleLeft'
    $label.Font = if ($strong) { UiFont 10.5 $true } else { UiFont 9 }
    $label.ForeColor = if ($strong) { $ink } else { $muted }
    return $label
}
[void]$summaryTable.Controls.Add((SummaryLabel '工作目录'), 0, 0)
[void]$summaryTable.Controls.Add((SummaryLabel '授权范围'), 1, 0)
$cwdValue = New-Object System.Windows.Forms.TextBox
$cwdValue.Text = [string]$request.workingDirectory
$cwdValue.ReadOnly = $true
$cwdValue.BorderStyle = 'None'
$cwdValue.BackColor = $white
$cwdValue.ForeColor = $ink
$cwdValue.Font = UiFont 10.5 $true
$cwdValue.Dock = 'Fill'
$cwdValue.Margin = New-Object System.Windows.Forms.Padding(0, (UiPx 3), (UiPx 12), 0)
[void]$summaryTable.Controls.Add($cwdValue, 0, 1)
[void]$summaryTable.Controls.Add((SummaryLabel '仅本次执行' $true), 1, 1)
[void]$summary.Controls.Add($summaryTable)
[void]$body.Controls.Add($summary, 0, 0)

$commandHeader = New-Object System.Windows.Forms.Panel
$commandHeader.Dock = 'Fill'
$commandHeader.BackColor = $surface
$commandTitle = SummaryLabel '准备执行的命令' $true
$commandTitle.Font = UiFont 11 $true
$commandTitle.Dock = 'None'
$commandTitle.Location = New-Object System.Drawing.Point(0, 0)
$commandTitle.Height = UiPx 28
[void]$commandHeader.Controls.Add($commandTitle)
$copyLink = New-Object System.Windows.Forms.LinkLabel
$copyLink.Text = '复制命令'
$copyLink.LinkColor = $blue
$copyLink.ActiveLinkColor = $blue
$copyLink.VisitedLinkColor = $blue
$copyLink.Font = UiFont 9
$copyLink.TextAlign = 'MiddleCenter'
$copyLink.Size = New-Object System.Drawing.Size((UiPx 78), (UiPx 28))
[void]$commandHeader.Controls.Add($copyLink)
$fullLink = New-Object System.Windows.Forms.LinkLabel
$fullLink.Text = '查看完整命令'
$fullLink.LinkColor = $blue
$fullLink.ActiveLinkColor = $blue
$fullLink.VisitedLinkColor = $blue
$fullLink.Font = UiFont 9
$fullLink.TextAlign = 'MiddleCenter'
$fullLink.Size = New-Object System.Drawing.Size((UiPx 104), (UiPx 28))
[void]$commandHeader.Controls.Add($fullLink)
$commandHeader.Add_Resize({
    $fullLink.Left = [Math]::Max(0, $commandHeader.ClientSize.Width - $fullLink.Width)
    $copyLink.Left = [Math]::Max(0, $fullLink.Left - $copyLink.Width - (UiPx 6))
    $commandTitle.Width = [Math]::Max(80, $copyLink.Left - (UiPx 8))
})
[void]$body.Controls.Add($commandHeader, 0, 2)

$commandCard = New-Object GuichenCard
$commandCard.Dock = 'Fill'
$commandCard.Margin = New-Object System.Windows.Forms.Padding(0)
$commandCard.FillColor = $codeBack
$commandCard.LineColor = $codeBack
$commandCard.Radius = UiPx 10
$commandCard.BackColor = $codeBack
$commandCard.Padding = New-Object System.Windows.Forms.Padding((UiPx 13), (UiPx 10), (UiPx 12), (UiPx 10))
$commandBox = New-Object System.Windows.Forms.TextBox
$commandBox.Multiline = $true
$commandBox.ReadOnly = $true
$commandBox.WordWrap = $false
$commandLines = ([string]$request.command -split "`r?`n")
$longCommandLine = @($commandLines | Where-Object { $_.Length -gt 60 }).Count -gt 0
$commandBox.ScrollBars = if ($commandLines.Count -gt 4 -and $longCommandLine) { 'Both' } elseif ($commandLines.Count -gt 4) { 'Vertical' } elseif ($longCommandLine) { 'Horizontal' } else { 'None' }
$commandBox.AcceptsReturn = $true
$commandBox.AcceptsTab = $true
$commandBox.BorderStyle = 'None'
$commandBox.BackColor = $codeBack
$commandBox.ForeColor = $codeText
$commandBox.Font = UiFont 10.5 $false $codeFamily
$commandBox.Text = UiMultiline ([string]$request.command)
$commandBox.Dock = 'Fill'
[void]$commandCard.Controls.Add($commandBox)
[void]$body.Controls.Add($commandCard, 0, 3)

function New-TextCard([string]$titleText, [string]$content, [System.Drawing.Color]$fill, [System.Drawing.Color]$border, [System.Drawing.Color]$foreground, [string]$note = '') {
    $card = New-Object GuichenCard
    $card.Dock = 'Fill'
    $card.Margin = New-Object System.Windows.Forms.Padding(0)
    $card.FillColor = $fill
    $card.LineColor = $border
    $card.Radius = UiPx 10
    $card.BackColor = $fill
    $card.Padding = New-Object System.Windows.Forms.Padding((UiPx 13), (UiPx 10), (UiPx 13), (UiPx 9))
    $table = New-Object System.Windows.Forms.TableLayoutPanel
    $table.Dock = 'Fill'
    $table.BackColor = $fill
    $table.ColumnCount = 1
    $table.RowCount = if ($note) { 3 } else { 2 }
    [void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    [void]$table.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, (UiPx 26))))
    [void]$table.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    if ($note) { [void]$table.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, (UiPx 20)))) }
    $titleLabel = SummaryLabel $titleText $true
    $titleLabel.Font = UiFont 10.5 $true
    $titleLabel.ForeColor = $foreground
    [void]$table.Controls.Add($titleLabel, 0, 0)
    $textBox = New-Object System.Windows.Forms.TextBox
    $textBox.Text = UiMultiline $content
    $textBox.ReadOnly = $true
    $textBox.Multiline = $true
    $textBox.WordWrap = $true
    $textBox.ScrollBars = if ($content.Length -gt 110 -or $content.Contains([Environment]::NewLine)) { 'Vertical' } else { 'None' }
    $textBox.BorderStyle = 'None'
    $textBox.BackColor = $fill
    $textBox.ForeColor = $foreground
    $textBox.Font = UiFont 9.5
    $textBox.Dock = 'Fill'
    $textBox.Margin = New-Object System.Windows.Forms.Padding(0)
    [void]$table.Controls.Add($textBox, 0, 1)
    if ($note) {
        $noteLabel = SummaryLabel $note
        $noteLabel.Font = UiFont 8.5
        [void]$table.Controls.Add($noteLabel, 0, 2)
    }
    [void]$card.Controls.Add($table)
    return $card
}
$purposeCard = New-TextCard '为什么需要执行？' ([string]$request.purpose) $white $line $ink '以下说明由 AI 提供，请以实际命令为准。'
[void]$body.Controls.Add($purposeCard, 0, 5)
$riskTranslations = @{
    'This command is not on the narrow automatic allowlist.' = '这条命令不在少量可自动放行的只读命令名单中。'
    'It contains command chaining, redirection, a pipeline, or multiple lines.' = '命令含有串联、重定向、管道或多行内容，可能连续执行多个操作。'
    'It invokes a runtime, package manager, build tool, or Git, which can execute project or configured code.' = '命令会调用运行时、包管理器、构建工具或 Git，可能执行项目或配置中的代码。'
    'It appears to change files, install software, or evaluate code.' = '命令可能修改文件、安装软件或执行代码。'
    'It may communicate with an external service.' = '命令可能连接外部服务。'
    'Its effects cannot be determined safely from a fixed rule.' = '固定规则无法准确判断这条命令的影响。'
}
$riskLines = @($request.reasons | ForEach-Object {
    $original = [string]$_
    '• ' + $(if ($riskTranslations.ContainsKey($original)) { $riskTranslations[$original] } else { $original })
})
$riskCard = New-TextCard ('执行前请注意  ·  ' + $riskText) ($riskLines -join [Environment]::NewLine) $riskBack $riskLine $riskInk
[void]$body.Controls.Add($riskCard, 0, 7)

$footer = New-Object System.Windows.Forms.Panel
$footer.Dock = 'Fill'
$footer.BackColor = $surface
$footerLine = New-Object System.Windows.Forms.Panel
$footerLine.BackColor = $line
$footerLine.Height = 1
$footerLine.Dock = 'Top'
[void]$footer.Controls.Add($footerLine)
$warningLabel = New-Object System.Windows.Forms.Label
$warningLabel.Text = '本次授权不会被记住。获批准的命令及其子进程仍可能使用当前 Windows 用户的权限；审批不等于操作系统沙箱。'
$warningLabel.ForeColor = $muted
$warningLabel.Font = UiFont 8.5
$warningLabel.Location = New-Object System.Drawing.Point(0, (UiPx 9))
$warningLabel.Height = UiPx 39
[void]$footer.Controls.Add($warningLabel)
$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.ForeColor = $blue
$statusLabel.Font = UiFont 8.5
$statusLabel.Location = New-Object System.Drawing.Point(0, (UiPx 55))
$statusLabel.Height = UiPx 24
$statusLabel.TextAlign = 'MiddleLeft'
[void]$footer.Controls.Add($statusLabel)
$deny = New-Object GuichenButton
$deny.Text = '拒绝'
$deny.FillColor = $white
$deny.LineColor = UiColor '#CDD5E0'
$deny.ForeColor = $ink
$deny.Font = UiFont 10 $true
$deny.Radius = UiPx 8
$deny.Size = New-Object System.Drawing.Size((UiPx 112), (UiPx 42))
[void]$footer.Controls.Add($deny)
$allow = New-Object GuichenButton
$allow.Text = '允许一次'
$allow.FillColor = $blue
$allow.LineColor = $blue
$allow.ForeColor = $white
$allow.Font = UiFont 10 $true
$allow.Radius = UiPx 8
$allow.IgnoreEnter = $true
$allow.Size = New-Object System.Drawing.Size((UiPx 122), (UiPx 42))
[void]$footer.Controls.Add($allow)
$footer.Add_Resize({
    $warningLabel.Width = $footer.ClientSize.Width
    $statusLabel.Width = [Math]::Max(100, $footer.ClientSize.Width - (UiPx 260))
    $allow.Left = [Math]::Max(0, $footer.ClientSize.Width - $allow.Width)
    $deny.Left = [Math]::Max(0, $allow.Left - $deny.Width - (UiPx 8))
    $allow.Top = [Math]::Max(0, $footer.ClientSize.Height - $allow.Height - (UiPx 4))
    $deny.Top = $allow.Top
})
[void]$root.Controls.Add($footer, 0, 2)

$copyLink.Add_LinkClicked({
    try {
        [System.Windows.Forms.Clipboard]::SetText([string]$request.command)
        $statusLabel.Text = '已复制完整命令。'
    } catch { $statusLabel.Text = '复制失败，请在命令区手动选择并复制。' }
})
$fullLink.Add_LinkClicked({
    $full = New-Object System.Windows.Forms.Form
    $full.Text = '完整命令 — 仅供检查'
    $full.StartPosition = 'CenterParent'
    $full.Size = New-Object System.Drawing.Size([int][Math]::Min((UiPx 900), ($work.Width * 0.82)), [int][Math]::Min((UiPx 540), ($work.Height * 0.78)))
    $full.MinimumSize = New-Object System.Drawing.Size((UiPx 440), (UiPx 270))
    $full.BackColor = $codeBack
    $full.Padding = New-Object System.Windows.Forms.Padding((UiPx 14))
    $fullBox = New-Object System.Windows.Forms.TextBox
    $fullBox.Text = UiMultiline ([string]$request.command)
    $fullBox.ReadOnly = $true
    $fullBox.Multiline = $true
    $fullBox.WordWrap = $false
    $fullBox.ScrollBars = 'Both'
    $fullBox.BorderStyle = 'None'
    $fullBox.BackColor = $codeBack
    $fullBox.ForeColor = $codeText
    $fullBox.Font = UiFont 10.5 $false $codeFamily
    $fullBox.Dock = 'Fill'
    [void]$full.Controls.Add($fullBox)
    [void]$full.ShowDialog($form)
    $full.Dispose()
})

$submitTimer = New-Object System.Windows.Forms.Timer
$submitTimer.Interval = 130
$submitTimer.Add_Tick({ $submitTimer.Stop(); $form.Close() })
$deny.Add_Click({
    if ($script:approvalDecision -ne 'window_closed') { return }
    $script:approvalDecision = 'denied'
    $deny.Enabled = $false
    $allow.Enabled = $false
    $statusLabel.Text = '正在提交拒绝结果…'
    Write-ApprovalEvent 'user_clicked_deny'
    $submitTimer.Start()
})
$allow.Add_Click({
    if ($script:approvalDecision -ne 'window_closed') { return }
    $script:approvalDecision = 'approved'
    $deny.Enabled = $false
    $allow.Enabled = $false
    $statusLabel.Text = '正在发送本次批准，等待本机服务确认…'
    Write-ApprovalEvent 'user_clicked_allow'
    $submitTimer.Start()
})
$form.AcceptButton = $deny
$form.CancelButton = $deny
$closeTimer = New-Object System.Windows.Forms.Timer
$closeTimer.Interval = 700
$closeTimer.Add_Tick({
    $closeTimer.Stop()
    $script:approvalDecision = 'denied'
    Write-ApprovalEvent 'test_auto_denied'
    $form.Close()
})
$form.Add_Shown({
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $form.Visible = $true
    [void][LocalCoderApprovalWindow]::ShowWindow($form.Handle, 5)
    $form.Activate()
    [void][LocalCoderApprovalWindow]::SetForegroundWindow($form.Handle)
    $body.Width = [Math]::Max(200, $bodyScroll.ClientSize.Width - (UiPx 2))
    $deny.Focus()
    if (-not [LocalCoderApprovalWindow]::IsWindowVisible($form.Handle)) {
        $script:approvalDecision = 'window_error'
        $script:approvalErrorCategory = 'dialog_not_visible'
        Write-ApprovalEvent 'window_error' $script:approvalErrorCategory
        $form.Close()
        return
    }
    Write-ApprovalEvent 'dialog_shown'
    if ($SelfTest) { $closeTimer.Start() }
})
