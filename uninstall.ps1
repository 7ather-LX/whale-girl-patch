# WhaleGirl patch uninstaller
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -AppRoot "D:\WhaleGirl"
#
# Optional:
#   -PurgeData   also delete data\whale-patch.json and the browser/frame cache
#   -RestoreBackup  restore server.js.whale-patch.bak instead of just removing the hook line

[CmdletBinding()]
param(
  [string]$AppRoot = "",
  [switch]$PurgeData,
  [switch]$RestoreBackup
)

$ErrorActionPreference = "Stop"

if (-not $AppRoot) {
  $candidate = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $candidate "server.js")) { $AppRoot = $candidate }
  else { Write-Host "Use -AppRoot ""D:\WhaleGirl""" -ForegroundColor Red; exit 1 }
}
$AppRoot = (Resolve-Path $AppRoot).Path
$serverPath = Join-Path $AppRoot "server.js"
$backup = "$serverPath.whale-patch.bak"
$dstPatch = Join-Path $AppRoot "whale-patch"

Write-Host ""
Write-Host "WhaleGirl patch uninstaller" -ForegroundColor Cyan
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

Write-Host ""
Write-Host "Done. Restart WhaleGirl from the launcher." -ForegroundColor Green
Write-Host ""
