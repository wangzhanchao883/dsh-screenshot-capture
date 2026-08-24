<#
  dsh-screenshot-capture · 剪贴板监听 + 系统级悬浮窗 (PowerShell 5.1, 零依赖)

  职责:
    1. 轮询剪贴板序列号(GetClipboardSequenceNumber),检测新图片(截图/Ctrl+C 图片)
    2. 检测到后:原图存到 $env:TEMP\dsh-capture\clip_<ts>.png
    3. 在鼠标当前位置弹出置顶小窗:图片预览 + 注释输入框 + 「重点」复选框
       + 【复制截图】【存文档】【存图片】
    4. 结果写入事件日志文件(每行一个 JSON),也尝试写 stdout

  协议(每行一个 JSON,写日志 + stdout):
    {"t":"ready"}
    {"t":"img","path":"...","seq":123}
    {"t":"choice","action":"doc|img|copy","path":"...","note":"用户注释","isKey":true}
    {"t":"err","msg":"..."}

  参数:
    -ConfigPath  JSON 配置文件(可选): pollIntervalMs / cooldownMs / offsetX / offsetY / previewMaxWidth
    -AutoAction  doc|img|copy|none  自动选择,不弹窗(自动化测试用);none=只检测不处理
    -Once        只处理一次后退出
#>
param(
  [string]$ConfigPath = "",
  [string]$AutoAction = "",
  [switch]$Once
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinClip {
  [DllImport("user32.dll")]
  public static extern uint GetClipboardSequenceNumber();
}
"@

$tempDir = Join-Path $env:TEMP "dsh-capture"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$logPath = Join-Path $tempDir "events.log"

function Write-Event([hashtable]$obj) {
  $line = $obj | ConvertTo-Json -Compress
  try { [System.IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [System.Text.Encoding]::UTF8) } catch {}
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch {}
}

$config = @{ pollIntervalMs = 200; cooldownMs = 2000; offsetX = 16; offsetY = 16; previewMaxWidth = 320 }
if ($ConfigPath -and (Test-Path $ConfigPath)) {
  try {
    $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    foreach ($k in @('pollIntervalMs','cooldownMs','offsetX','offsetY','previewMaxWidth')) {
      if ($null -ne $cfg.$k) { $config[$k] = $cfg.$k }
    }
  } catch { Write-Event @{ t = "err"; msg = "config parse: $($_.Exception.Message)" } }
}

function Show-CaptureDialog {
  param([string]$ImagePath)
  $form = New-Object System.Windows.Forms.Form
  $img = $null
  try {
  $form.Text = "截图入库"
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.KeyPreview = $true
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false

  $img = [System.Drawing.Image]::FromFile($ImagePath)
  $maxW = [int]$config.previewMaxWidth
  $w = [Math]::Max(1, $img.Width)
  $h = [Math]::Max(1, $img.Height)
  $scale = [Math]::Min(1.0, $maxW / $w)
  $pw = [Math]::Max(160, [int]($w * $scale))
  $ph = [Math]::Max(100, [int]($h * $scale))

  $pic = New-Object System.Windows.Forms.PictureBox
  $pic.Width = $pw
  $pic.Height = $ph
  $pic.Image = $img
  $pic.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
  $pic.Location = New-Object System.Drawing.Point(8, 8)

  $bw = 88; $bh = 32; $pad = 8; $gap = 6
  $totalW = $pad * 2 + $bw * 3 + $gap * 2
  $noteW = $totalW - $pad * 2
  $noteH = 60
  $noteY = 8 + $ph + 8
  $chkY = $noteY + $noteH + 6
  $rowY = $chkY + 24 + 10
  $totalH = $rowY + $bh + $pad

  $noteBox = New-Object System.Windows.Forms.TextBox
  $noteBox.Multiline = $true
  $noteBox.AcceptsReturn = $true
  $noteBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $noteBox.Width = $noteW
  $noteBox.Height = $noteH
  $noteBox.Location = New-Object System.Drawing.Point($pad, $noteY)
  $noteBox.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)
  try { $noteBox.PlaceholderText = "截图注释 / 评论(可选)…" } catch {}

  $chkKey = New-Object System.Windows.Forms.CheckBox
  $chkKey.Text = "重点"
  $chkKey.Width = 80; $chkKey.Height = 24
  $chkKey.Location = New-Object System.Drawing.Point($pad, $chkY)
  $chkKey.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)
  $chkKey.Checked = $false

  $bCopy = New-Object System.Windows.Forms.Button
  $bCopy.Text = "复制截图"; $bCopy.Tag = "copy"; $bCopy.Width = $bw; $bCopy.Height = $bh
  $bCopy.Location = New-Object System.Drawing.Point($pad, $rowY)
  $bCopy.Add_Click({ $form.Tag = "copy"; $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel })

  $bDoc = New-Object System.Windows.Forms.Button
  $bDoc.Text = "存文档"; $bDoc.Tag = "doc"; $bDoc.Width = $bw; $bDoc.Height = $bh
  $bDoc.Location = New-Object System.Drawing.Point(($pad + $bw + $gap), $rowY)
  $bDoc.Add_Click({ $form.Tag = "doc"; $form.DialogResult = [System.Windows.Forms.DialogResult]::OK })

  $bImg = New-Object System.Windows.Forms.Button
  $bImg.Text = "存图片"; $bImg.Tag = "img"; $bImg.Width = $bw; $bImg.Height = $bh
  $bImg.Location = New-Object System.Drawing.Point(($pad + ($bw + $gap) * 2), $rowY)
  $bImg.Add_Click({ $form.Tag = "img"; $form.DialogResult = [System.Windows.Forms.DialogResult]::Yes })

  $form.AcceptButton = $bDoc
  $form.CancelButton = $bCopy
  $form.Add_KeyDown({ param($s, $e) if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $form.Tag = "copy"; $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel } })

  $form.Controls.AddRange(@($pic, $noteBox, $chkKey, $bCopy, $bDoc, $bImg))
  $form.ClientSize = New-Object System.Drawing.Size($totalW, $totalH)

  $cursor = [System.Windows.Forms.Cursor]::Position
  $screen = [System.Windows.Forms.Screen]::FromPoint($cursor)
  $wa = $screen.WorkingArea
  $x = $cursor.X + [int]$config.offsetX
  $y = $cursor.Y + [int]$config.offsetY
  if ($x + $totalW -gt $wa.Right)  { $x = $cursor.X - $totalW - [int]$config.offsetX }
  if ($y + $totalH -gt $wa.Bottom) { $y = $cursor.Y - $totalH - [int]$config.offsetY }
  $x = [Math]::Max($wa.Left, $x)
  $y = [Math]::Max($wa.Top, $y)
  $form.Location = New-Object System.Drawing.Point($x, $y)

  [void]$form.ShowDialog()
  $action = if ($form.Tag) { $form.Tag.ToString() } else { "copy" }
  $note = $noteBox.Text.Trim()
  $isKey = [bool]$chkKey.Checked
  return @{ action = $action; note = $note; isKey = $isKey }
  } finally {
    if ($null -ne $form) { $form.Dispose() }
    if ($null -ne $img) { $img.Dispose() }
  }
}

Write-Event @{ t = "ready" }
$lastSeq = [WinClip]::GetClipboardSequenceNumber()
$lastHandled = [DateTime]::Now

while ($true) {
  Start-Sleep -Milliseconds ([int]$config.pollIntervalMs)
  $seq = 0
  try { $seq = [WinClip]::GetClipboardSequenceNumber() } catch { continue }
  if ($seq -eq $lastSeq) { continue }
  $lastSeq = $seq
  $now = [DateTime]::Now
  if (($now - $lastHandled).TotalMilliseconds -lt [int]$config.cooldownMs) { continue }
  if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { continue }
  $img = $null
  try { $img = [System.Windows.Forms.Clipboard]::GetImage() } catch { continue }
  if ($null -eq $img) { continue }
  $lastHandled = $now
  $ts = Get-Date -Format "yyyyMMdd_HHmmss_fff"
  $pngPath = Join-Path $tempDir ("clip_{0}.png" -f $ts)
  try {
    $img.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } catch {
    $img.Dispose()
    Write-Event @{ t = "err"; msg = "save: $($_.Exception.Message)" }
    continue
  }
  $img.Dispose()
  Write-Event @{ t = "img"; path = $pngPath; seq = $seq }

  if ($AutoAction) {
    if ($AutoAction -ne "none") { Write-Event @{ t = "choice"; action = $AutoAction; path = $pngPath } }
    if ($Once) { break }
    continue
  }

  $res = @{ action = "copy"; note = ""; isKey = $false }
  try { $res = Show-CaptureDialog -ImagePath $pngPath } catch {
    Write-Event @{ t = "err"; msg = "dialog: $($_.Exception.Message)" }
  }
  Write-Event @{ t = "choice"; action = $res.action; path = $pngPath; note = $res.note; isKey = $res.isKey }
  if ($Once) { break }
}
