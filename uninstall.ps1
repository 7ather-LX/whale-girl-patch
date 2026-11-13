# WhaleGirl patch uninstaller
#
# Easiest: double-click uninstall.cmd (it calls this script).
# Manual:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -AppRoot "D:\WhaleGirl"
#
# Optional:
#   -PurgeData      also delete data\whale-patch.json and the browser/frame cache
#   -RestoreBackup  restore server.js.whale-patch.bak instead of just removing the hook line

[CmdletBinding()]
param(
  [string]$AppRoot = "",
  [switch]$PurgeData,
  [switch]$RestoreBackup
)

$ErrorActionPreference = "Stop"

function Test-AppRoot([string]$Path) {
  if (-not $Path) { return $false }
  try { $p = [System.IO.Path]::GetFullPath($Path) } catch { return $false }
  return (Test-Path (Join-Path $p "server.js")) -and (Test-Path (Join-Path $p "src\app.js"))
}

function Find-AppRoot {
  $list = New-Object System.Collections.Generic.List[string]
  if ($env:WHALE_APP_ROOT) { $list.Add($env:WHALE_APP_ROOT) }
  $parent = Split-Path -Parent $PSScriptRoot
  $list.Add($parent)
  $list.Add((Join-Path $parent "WhaleGirl"))
  try {
    $proc = Get-Process WhaleLauncher -ErrorAction Stop | Select-Object -First 1
    if ($proc -and $proc.Path) { $list.Add((Split-Path -Parent $proc.Path)) }
  } catch { /* ignore */ }
  foreach ($reg in @(
      "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*")) {
    try {
      Get-ItemProperty $reg -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match "Whale|鲸鲸" -and $_.InstallLocation } |
        ForEach-Object { $list.Add([string]$_.InstallLocation) }
    } catch { /* ignore */ }
  }
  $common = @(
    (Join-Path $env:LOCALAPPDATA "Programs\WhaleGirl"),
    (Join-Path $env:LOCALAPPDATA "WhaleGirl"),
    (Join-Path $env:ProgramFiles "WhaleGirl"),
    "D:\WhaleGirl", "E:\WhaleGirl", "F:\WhaleGirl"
  )
  foreach ($c in $common) { if ($c) { $list.Add($c) } }
  foreach ($candidate in $list) {
    if (Test-AppRoot $candidate) { return (Resolve-Path $candidate).Path }
  }
  return ""
}

function Pick-AppRoot {
  try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Select the WhaleGirl folder (the one that contains server.js)."
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return "" }
    return $dialog.SelectedPath
  } catch {
    return ""
  }
}

Write-Host ""
Write-Host "WhaleGirl patch uninstaller" -ForegroundColor Cyan
Write-Host ""

if (-not $AppRoot) { $AppRoot = Find-AppRoot }
if (-not $AppRoot) { $AppRoot = Pick-AppRoot }
if (-not $AppRoot -or -not (Test-AppRoot $AppRoot)) {
  Write-Host "WhaleGirl folder not found. Use -AppRoot ""D:\WhaleGirl""." -ForegroundColor Red
  exit 1
}
$AppRoot = (Resolve-Path $AppRoot).Path
$serverPath = Join-Path $AppRoot "server.js"
$backup = "$serverPath.whale-patch.bak"
$dstPatch = Join-Path $AppRoot "whale-patch"

Write-Host "  target: $AppRoot"
Write-Host ""

$node = Join-Path $AppRoot "runtime\node.exe"
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}

if ($RestoreBackup -and (Test-Path $backup)) {
  Copy-Item $backup $serverPath -Force
  Remove-Item $backup -Force
  Write-Host "  restored server.js from backup" -ForegroundColor Green
} elseif (Test-Path $serverPath) {
  $content = [System.IO.File]::ReadAllText($serverPath, [System.Text.Encoding]::UTF8)
  $pattern = "(?m)^\s*require\s*\(\s*['""]\./whale-patch['""]\s*\)\s*\.install\s*\(\s*\)\s*;?\s*\r?\n?"
  $next = [regex]::Replace($content, $pattern, "")
  if ($next -ne $content) {
    [System.IO.File]::WriteAllText($serverPath, $next, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "  hook removed from server.js" -ForegroundColor Green
  } else {
    Write-Host "  hook not found in server.js (already clean?)"
  }
  if ($node -and (Test-Path $node)) {
    & $node --check $serverPath
    if ($LASTEXITCODE -ne 0) { Write-Host "  [WARN] server.js syntax check failed; restore the .bak manually" -ForegroundColor Yellow }
  }
}

if (Test-Path $dstPatch) {
  Remove-Item $dstPatch -Recurse -Force
  Write-Host "  removed whale-patch\" -ForegroundColor Green
}

if ($PurgeData) {
  $cfg = Join-Path $AppRoot "data\whale-patch.json"
  if (Test-Path $cfg) { Remove-Item $cfg -Force; Write-Host "  removed data\whale-patch.json" -ForegroundColor Green }
  $cache = Join-Path $AppRoot "data\whale-patch"
  if (Test-Path $cache) { Remove-Item $cache -Recurse -Force; Write-Host "  removed data\whale-patch\" -ForegroundColor Green }
}

# 还原被替换的启动器（如果装过「补丁」页）
$launcher = Join-Path $AppRoot "WhaleLauncher.exe"
$launcherBackup = "$launcher.whale-patch.bak"
$launcherMarker = "$launcher.whale-patch.installed"
if (Test-Path $launcherBackup) {
  try {
    Copy-Item $launcherBackup $launcher -Force -ErrorAction Stop
    Remove-Item $launcherBackup -Force
    Write-Host "  restored WhaleLauncher.exe" -ForegroundColor Green
  } catch {
    $old = "${launcher}.patched-" + [DateTime]::Now.ToString("yyyyMMddHHmmss")
    try {
      Move-Item $launcher $old -Force -ErrorAction Stop
      Copy-Item $launcherBackup $launcher -Force -ErrorAction Stop
      Remove-Item $launcherBackup -Force
      Write-Host "  restored WhaleLauncher.exe (old: $old)" -ForegroundColor Green
    } catch {
      Write-Host "  [WARN] could not restore WhaleLauncher.exe; reinstall WhaleGirl or copy back $launcherBackup" -ForegroundColor Yellow
    }
  }
}
if (Test-Path $launcherMarker) { Remove-Item $launcherMarker -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "Done. Restart WhaleGirl from the launcher." -ForegroundColor Green
Write-Host ""
