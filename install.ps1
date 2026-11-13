# WhaleGirl patch installer (Windows PowerShell 5.1+ / PowerShell 7)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -AppRoot "D:\WhaleGirl"
#
# Optional:
#   -EnableAllShared   create a scope "All chats" and enable cross-chat memory
#   -NoBackup          do not keep server.js.whale-patch.bak
#
# The installer is idempotent: run it again to update the patch files.

[CmdletBinding()]
param(
  [string]$AppRoot = "",
  [switch]$EnableAllShared,
  [switch]$NoBackup
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  Write-Host ""
  Write-Host "[ERROR] $Message" -ForegroundColor Red
  exit 1
}

function Info([string]$Message) {
  Write-Host "  $Message"
}

if (-not $AppRoot) {
  $candidate = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $candidate "server.js")) {
    $AppRoot = $candidate
  } else {
    Fail "AppRoot not given. Use: -AppRoot ""D:\WhaleGirl"""
  }
}

if (-not (Test-Path $AppRoot)) { Fail "AppRoot does not exist: $AppRoot" }
$AppRoot = (Resolve-Path $AppRoot).Path

$serverPath = Join-Path $AppRoot "server.js"
$srcApp = Join-Path $AppRoot "src\app.js"
$pkgPath = Join-Path $AppRoot "package.json"
if (-not (Test-Path $serverPath)) { Fail "server.js not found in $AppRoot" }
if (-not (Test-Path $srcApp)) { Fail "src\app.js not found. This does not look like a WhaleGirl install." }
if (-not (Test-Path $pkgPath)) { Fail "package.json not found in $AppRoot" }

$pkg = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Write-Host ""
Write-Host "WhaleGirl patch installer" -ForegroundColor Cyan
Write-Host "  target : $AppRoot"
Write-Host "  version: $($pkg.version)"
Write-Host ""

# 1) node
$node = Join-Path $AppRoot "runtime\node.exe"
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node -or -not (Test-Path $node)) { Fail "Node.js not found (runtime\node.exe or PATH)." }
Info "node: $node"

# 2) copy patch files
$srcPatch = Join-Path $PSScriptRoot "patch"
$dstPatch = Join-Path $AppRoot "whale-patch"
if (-not (Test-Path (Join-Path $srcPatch "index.js"))) { Fail "patch\index.js not found next to install.ps1" }
New-Item -ItemType Directory -Force -Path $dstPatch | Out-Null
Copy-Item -Path (Join-Path $srcPatch "*") -Destination $dstPatch -Recurse -Force
Info "copied patch -> $dstPatch"

# 3) backup server.js once
if (-not $NoBackup) {
  $backup = "$serverPath.whale-patch.bak"
  if (-not (Test-Path $backup)) {
    Copy-Item $serverPath $backup -Force
    Info "backup: $backup"
  }
}

# 4) add the one-line hook at the top of server.js (idempotent)
$marker = "require('./whale-patch').install();"
$content = [System.IO.File]::ReadAllText($serverPath, [System.Text.Encoding]::UTF8)
$hookRe = "require\s*\(\s*['""]\./whale-patch['""]\s*\)\s*\.install\s*\(\s*\)\s*;?"
if ($content -notmatch $hookRe) {
  $content = $content.TrimStart([char]0xFEFF)
  $content = $marker + "`r`n" + $content
  [System.IO.File]::WriteAllText($serverPath, $content, (New-Object System.Text.UTF8Encoding($false)))
  Info "hook added to server.js"
} else {
  Info "hook already present in server.js"
}

# 5) syntax check
& $node --check $serverPath
if ($LASTEXITCODE -ne 0) { Fail "server.js syntax check failed. Restore server.js.whale-patch.bak and try again." }
Info "server.js syntax OK"

# 6) default patch config (never overwrite an existing one)
Push-Location $AppRoot
try {
  & $node -e "const c=require('./whale-patch/config'); const s=c.ensure(process.cwd()); console.log('config:', s.file, s.exists ? '(exists)' : '(created)');"
  if ($LASTEXITCODE -ne 0) { Fail "could not create data\whale-patch.json" }

  if ($EnableAllShared) {
    $js = @"
const c = require('./whale-patch/config');
const root = process.cwd();
const state = c.load(root);
const cfg = state.config;
cfg.sharedMemory.enabled = true;
cfg.sharedMemory.scopes = [{ id: 'all', name: 'All chats', mode: 'both', enabled: true, sharePeople: false, chats: ['*'] }];
c.save(root, cfg);
console.log('shared memory: enabled, scope=all chats');
"@
    & $node -e $js
    if ($LASTEXITCODE -ne 0) { Fail "could not enable shared memory" }
  }
} finally {
  Pop-Location
}

# 7) port hint
$port = "8787"
$portFile = Join-Path $AppRoot "data\server-port.txt"
if (Test-Path $portFile) {
  $rawPort = (Get-Content $portFile -Raw).Trim()
  if ($rawPort -match '^\d+$') { $port = $rawPort }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  1) Restart WhaleGirl from the launcher (stop -> start) so server.js reloads."
Write-Host "  2) Open the patch console:  http://127.0.0.1:$port/patch/"
Write-Host "  3) CLI self-check:  `"$node`" `"$(Join-Path $dstPatch 'cli.js')`" doctor"
Write-Host "  4) Uninstall:       powershell -ExecutionPolicy Bypass -File uninstall.ps1 -AppRoot `"$AppRoot`""
Write-Host ""
