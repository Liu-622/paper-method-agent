# Unified local start (contains NO secrets and does NOT inject any).
#
# Usage (PowerShell, from the project root):
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1
#
# How configuration works now (single source of truth):
#   The server loads its own config via server\loadenv.mjs, with a fixed priority:
#     process environment variables  >  .env.local  >  .env  >  config.env  >  built-in defaults
#   This script does NOT parse or inject anything, so the development start,
#   the restart script and the portable entry all behave identically.
#   "Config present but not injected" can no longer happen because of how you start.
#
# Secrets never enter the frontend, logs, exports or the portable package.

$ErrorActionPreference = 'Stop'
# Make sure Chinese output from node is not garbled in Windows PowerShell 5.1
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not $env:PORT) { $env:PORT = '8787' }
$port = [int]$env:PORT

# ---- report the effective configuration (names only, never values) ----
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
Write-Host "==== effective configuration ====" -ForegroundColor Cyan
& $node (Join-Path $root 'scripts\env-report.mjs')
Write-Host ""

if (-not (Test-Path (Join-Path $root 'dist\index.html'))) {
  Write-Host "[build] dist missing, running npm run build ..." -ForegroundColor Yellow
  & npm run build
}

$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  Write-Host "[port] $port is already in use by PID=$($busy.OwningProcess)." -ForegroundColor Red
  Write-Host "       To restart with the new configuration, run:" -ForegroundColor Yellow
  Write-Host "       powershell -ExecutionPolicy Bypass -File scripts\restart-local.ps1" -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "Backend (serving dist): http://127.0.0.1:$port/" -ForegroundColor Cyan
Write-Host "Keep this terminal open; press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host ""
# The server loads the config itself; no injection here, no silent fallback.
& $node server/index.mjs
