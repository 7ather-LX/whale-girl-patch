# WhaleGirl patch installer (Windows PowerShell 5.1+ / PowerShell 7)
#
# IMPORTANT: this is a PATCH, not a standalone application.
# It only works after WhaleGirl / 鲸鲸 is installed:
#   https://github.com/Banan1cee/whale_girl
#
# Easiest: double-click install.cmd (it calls this script).
# Manual:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -AppRoot "D:\WhaleGirl"
#
# Optional:
#   -EnableAllShared   create a scope "All groups" and enable cross-chat memory
#   -NoBackup          do not keep server.js.whale-patch.bak
#
# The installer is idempotent: run it again to update the patch files.

[CmdletBinding()]
param(
  [string]$AppRoot = "",
  [switch]$EnableAllShared,
  [switch]$NoBackup,
  [switch]$SkipLauncher,
  [switch]$CreateShortcuts,
  [switch]$NoShortcuts
)

$ErrorActionPreference = "Stop"

function Info([string]$Message) { Write-Host "  $Message" }
function Step([string]$Message) { Write-Host ""; Write-Host "== $Message" -ForegroundColor Cyan }
function Fail([string]$Message) {
  Write-Host ""
  Write-Host "[ERROR] $Message" -ForegroundColor Red
  Write-Host "Base software (required): https://github.com/Banan1cee/whale_girl"
  exit 1
}

function Test-AppRoot([string]$Path) {
  if (-not $Path) { return $false }
  try { $p = [System.IO.Path]::GetFullPath($Path) } catch { return $false }
  if (-not (Test-Path $p)) { return $false }
  return (Test-Path (Join-Path $p "server.js")) -and (Test-Path (Join-Path $p "src\app.js"))
}

function Find-AppRoot {
  $list = New-Object System.Collections.Generic.List[string]

  if ($env:WHALE_APP_ROOT) { $list.Add($env:WHALE_APP_ROOT) }

  # 1) installer extracted next to / inside the app
  $parent = Split-Path -Parent $PSScriptRoot
  $list.Add($parent)
  $list.Add((Join-Path $parent "WhaleGirl"))

  # 2) running launcher
  try {
    $proc = Get-Process WhaleLauncher -ErrorAction Stop | Select-Object -First 1
    if ($proc -and $proc.Path) { $list.Add((Split-Path -Parent $proc.Path)) }
  } catch { /* ignore */ }

  # 3) uninstall registry entries
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

  # 4) common install locations
  $pf86 = ${env:ProgramFiles(x86)}
  $common = @(
    (Join-Path $env:LOCALAPPDATA "Programs\WhaleGirl"),
    (Join-Path $env:LOCALAPPDATA "WhaleGirl"),
    (Join-Path $env:ProgramFiles "WhaleGirl"),
    "D:\WhaleGirl", "E:\WhaleGirl", "F:\WhaleGirl",
    "D:\whale_girl", "E:\whale_girl", "F:\whale_girl"
  )
  if ($pf86) { $common += (Join-Path $pf86 "WhaleGirl") }
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
    $dialog.Description = "Select the WhaleGirl folder (the one that contains server.js). It is NOT this patch folder."
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return "" }
    return $dialog.SelectedPath
  } catch {
    return ""
  }
}

function New-Shortcuts([int]$Port) {
  $created = @()
  try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    if (-not $desktop -or -not (Test-Path $desktop)) { return $created }
    $shell = New-Object -ComObject WScript.Shell

    $installer = Join-Path $PSScriptRoot "install.cmd"
    if (Test-Path $installer) {
      $lnkPath = Join-Path $desktop "鲸鲸补丁-安装或更新.lnk"
      $lnk = $shell.CreateShortcut($lnkPath)
      $lnk.TargetPath = $installer
      $lnk.WorkingDirectory = $PSScriptRoot
      $lnk.Description = "安装/更新鲸鲸补丁（先装 WhaleGirl 本体）"
      $lnk.Save()
      $created += $lnkPath
    }

    $urlPath = Join-Path $desktop "鲸鲸补丁-控制台.url"
    $url = $shell.CreateShortcut($urlPath)
    $url.TargetPath = "http://127.0.0.1:$Port/patch/"
    $url.Save()
    $created += $urlPath
  } catch {
    Info "could not create desktop shortcuts: $($_.Exception.Message)"
  }
  return $created
}

Write-Host ""
Write-Host "WhaleGirl patch installer" -ForegroundColor Cyan
Write-Host "  This is a PATCH. It cannot run on its own." -ForegroundColor Yellow
Write-Host "  Base software: WhaleGirl 4.0.x / 4.1.0"
Write-Host "  https://github.com/Banan1cee/whale_girl"
Write-Host ""

if (-not $AppRoot) { $AppRoot = Find-AppRoot }
if (-not $AppRoot) {
  Write-Host "WhaleGirl was not found automatically." -ForegroundColor Yellow
  Write-Host "In the next dialog, choose the folder that contains server.js."
  $AppRoot = Pick-AppRoot
  if (-not $AppRoot) {
    Fail "No WhaleGirl folder selected. Install WhaleGirl first, then run this installer again."
  }
}

if (-not (Test-AppRoot $AppRoot)) {
  Fail "This folder does not look like a WhaleGirl install (server.js / src\app.js missing): $AppRoot"
}
$AppRoot = (Resolve-Path $AppRoot).Path

$serverPath = Join-Path $AppRoot "server.js"
$srcApp = Join-Path $AppRoot "src\app.js"
$pkgPath = Join-Path $AppRoot "package.json"
if (-not (Test-Path $pkgPath)) { Fail "package.json not found in $AppRoot" }

$pkg = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Write-Host "  target : $AppRoot"
Write-Host "  version: $($pkg.version)"
Write-Host ""

Step "1/6 Check Node.js"
$node = Join-Path $AppRoot "runtime\node.exe"
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node -or -not (Test-Path $node)) { Fail "Node.js not found (runtime\node.exe or PATH)." }
Info "node: $node"

Step "2/6 Copy patch files"
$srcPatch = Join-Path $PSScriptRoot "patch"
$dstPatch = Join-Path $AppRoot "whale-patch"
if (-not (Test-Path (Join-Path $srcPatch "index.js"))) { Fail "patch\index.js not found next to install.ps1" }
New-Item -ItemType Directory -Force -Path $dstPatch | Out-Null
Copy-Item -Path (Join-Path $srcPatch "*") -Destination $dstPatch -Recurse -Force
Info "copied -> $dstPatch"

Step "3/6 Add the one-line hook to server.js"
if (-not $NoBackup) {
  $backup = "$serverPath.whale-patch.bak"
  if (-not (Test-Path $backup)) {
    Copy-Item $serverPath $backup -Force
    Info "backup: $backup"
  }
}
$marker = "require('./whale-patch').install();"
$content = [System.IO.File]::ReadAllText($serverPath, [System.Text.Encoding]::UTF8)
$hookRe = "require\s*\(\s*['""]\./whale-patch['""]\s*\)\s*\.install\s*\(\s*\)\s*;?"
if ($content -notmatch $hookRe) {
  $content = $content.TrimStart([char]0xFEFF)
  $content = $marker + "`r`n" + $content
  [System.IO.File]::WriteAllText($serverPath, $content, (New-Object System.Text.UTF8Encoding($false)))
  Info "hook added"
} else {
  Info "hook already present (updating files only)"
}

Step "4/6 Syntax and module check"
& $node --check $serverPath
if ($LASTEXITCODE -ne 0) { Fail "server.js syntax check failed. Restore server.js.whale-patch.bak and try again." }
Info "server.js syntax OK"
Push-Location $AppRoot
try {
  & $node -e "require('./whale-patch'); console.log('patch module OK')"
  if ($LASTEXITCODE -ne 0) { Fail "patch module failed to load." }
} finally {
  Pop-Location
}

Step "5/6 Create / keep patch config"
Push-Location $AppRoot
try {
  & $node -e "const c=require('./whale-patch/config'); const s=c.ensure(process.cwd()); console.log('config:', s.file);"
  if ($LASTEXITCODE -ne 0) { Fail "could not create data\whale-patch.json" }

  if ($EnableAllShared) {
    $js = @"
const c = require('./whale-patch/config');
const root = process.cwd();
const state = c.load(root);
const cfg = state.config;
cfg.sharedMemory.enabled = true;
cfg.sharedMemory.scopes = [{ id: 'groups', name: 'All groups', match: 'group', mode: 'both', enabled: true, sharePeople: false, chats: ['*'] }];
c.save(root, cfg);
console.log('shared memory: enabled, all groups');
"@
    & $node -e $js
    if ($LASTEXITCODE -ne 0) { Fail "could not enable shared memory" }
  }
} finally {
  Pop-Location
}

Step "6/6 Install launcher tab (optional)"
$launcherSrc = Join-Path $PSScriptRoot "launcher\WhaleLauncher.exe"
$launcherVerFile = Join-Path $PSScriptRoot "launcher\version.txt"
$launcherDst = Join-Path $AppRoot "WhaleLauncher.exe"
if ($SkipLauncher) {
  Info "skipped by -SkipLauncher (web console still available at /patch/)"
} elseif (-not (Test-Path $launcherSrc)) {
  Info "launcher\WhaleLauncher.exe not found (source checkout?) - using web console only"
} elseif (-not (Test-Path $launcherDst)) {
  Info "WhaleLauncher.exe not found in app - using web console only"
} else {
  $launcherVer = ""
  if (Test-Path $launcherVerFile) { $launcherVer = (Get-Content $launcherVerFile -Raw).Trim() }
  if ($launcherVer -and $launcherVer -ne [string]$pkg.version) {
    Info "launcher tab build is for $launcherVer, base is $($pkg.version) - skipped (web console still works)"
    Info "after the base updates, re-run install.cmd when a matching launcher build is released"
  } else {
    $launcherBackup = "$launcherDst.whale-patch.bak"
    $launcherMarker = "$launcherDst.whale-patch.installed"
    $markerVersion = ""
    if (Test-Path $launcherMarker) { $markerVersion = (Get-Content $launcherMarker -Raw).Trim() }
    if (-not $markerVersion -or $markerVersion -ne [string]$pkg.version) {
      try { Copy-Item $launcherDst $launcherBackup -Force -ErrorAction Stop; Info "launcher backup: $launcherBackup" }
      catch { Info "could not back up launcher: $($_.Exception.Message)" }
    }
    $installed = $false
    try {
      Copy-Item $launcherSrc $launcherDst -Force -ErrorAction Stop
      $installed = $true
    } catch {
      # 启动器正在运行：Windows 不允许覆盖，但允许改名。改名后放新文件，下次启动生效。
      $stamp = [DateTime]::Now.ToString("yyyyMMddHHmmss")
      $oldPath = Join-Path (Split-Path -Parent $launcherDst) ("WhaleLauncher.exe.old-" + $stamp)
      Info "launcher is locked; trying rename -> $oldPath"
      try {
        Move-Item -LiteralPath $launcherDst -Destination $oldPath -Force -ErrorAction Stop
        Copy-Item -LiteralPath $launcherSrc -Destination $launcherDst -Force -ErrorAction Stop
        $installed = $true
        Info "launcher replaced; old file: $oldPath"
      } catch {
        Info "launcher not replaced: $($_.Exception.Message)"
        Info "close WhaleGirl completely and run install.cmd again to enable the tab"
      }
    }
    if ($installed) {
      try { Set-Content -Path $launcherMarker -Value ([string]$pkg.version) -Encoding ASCII } catch { }
      Info "launcher tab installed (restart WhaleGirl to see it)"
    }
  }
}

$port = "8787"
$portFile = Join-Path $AppRoot "data\server-port.txt"
if (Test-Path $portFile) {
  $rawPort = (Get-Content $portFile -Raw).Trim()
  if ($rawPort -match '^\d+$') { $port = $rawPort }
}

if (-not $NoShortcuts -and -not $CreateShortcuts) {
  $answer = Read-Host "Create desktop shortcuts (install/update + patch console)? [Y/n]"
  if ($answer -notmatch '^\s*[nN]') { $CreateShortcuts = $true }
}
if ($CreateShortcuts) {
  $made = New-Shortcuts -Port ([int]$port)
  if ($made.Count -gt 0) {
    Info "desktop shortcuts:"
    foreach ($m in $made) { Info "  $m" }
  }
} else {
  Info "desktop shortcuts skipped."
  Info "Update without a shortcut: download the latest ZIP from"
  Info "  https://github.com/7ather-LX/whale-girl-patch/releases/latest"
  Info "extract it, then double-click install.cmd in the extracted folder."
}

Write-Host ""
Write-Host "Installed successfully." -ForegroundColor Green
Write-Host ""
Write-Host "  Last step: FULLY EXIT the WhaleGirl launcher (tray icon -> Exit), then open it again." -ForegroundColor Yellow
Write-Host "  A normal 'Restart' only restarts the kernel; the new 'Patch' tab needs a launcher restart."
Write-Host "  Then open:  http://127.0.0.1:$port/patch/"
Write-Host ""
Write-Host "  Self-check: `"$node`" `"$(Join-Path $dstPatch 'cli.js')`" doctor"
Write-Host "  Uninstall : double-click uninstall.cmd (or uninstall.ps1 -AppRoot `"$AppRoot`")"
Write-Host ""
