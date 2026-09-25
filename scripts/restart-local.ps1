# Restart the local backend and self-check the model.
# ASCII only (PowerShell 5.1 reads non-ASCII .ps1 as ANSI and breaks).
#
# Usage (project root):
#   powershell -ExecutionPolicy Bypass -File scripts\restart-local.ps1
#
# What it does:
#   1. reports the effective configuration via scripts\env-report.mjs
#      (the server's own loader is the single source of truth; nothing is injected here)
#   2. stops whatever is listening on the target port
#   3. starts server/index.mjs in the background (logs: server-run.log / server-run.err.log)
#   4. waits for /api/health and prints the config source reported by the server itself
#   5. runs scripts/probe-minimal-llm.mjs ONLY when credentials are present
#
# Missing credentials is NOT an error: the app still starts, and it will say
# "model unavailable" instead of silently falling back to rule-based results.

$ErrorActionPreference = 'Stop'
# Node prints Chinese status lines; without this Windows PowerShell 5.1 garbles them.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not $env:PORT) { $env:PORT = '8787' }
$port = [int]$env:PORT

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

# ---- 1. effective configuration ----
Write-Host "==== effective configuration ====" -ForegroundColor Cyan
& $node (Join-Path $root 'scripts\env-report.mjs')
Write-Host ""

# ---- 2. stop the current listener ----
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  Write-Host "[port] stopping PID=$($busy.OwningProcess) on port $port ..."
  Stop-Process -Id $busy.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

# ---- 3. start in background ----
$p = Start-Process -FilePath $node -ArgumentList 'server\index.mjs' -WorkingDirectory $root `
  -RedirectStandardOutput (Join-Path $root 'server-run.log') `
  -RedirectStandardError (Join-Path $root 'server-run.err.log') `
  -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 4
Write-Host "[run] backend PID=$($p.Id) (logs: server-run.log, server-run.err.log)"

# ---- 4. health ----
$health = $null
for ($i = 0; $i -lt 10; $i++) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 8
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $health) {
  Write-Host "[health] failed to reach /api/health - see server-run.err.log" -ForegroundColor Red
  exit 3
}
Write-Host "[health] ok=$($health.ok) hasCredentials=$($health.hasCredentials) apiStyle=$($health.apiStyle) baseUrlHost=$($health.baseUrlHost)"
Write-Host "[health] capabilities: extract=$($health.capabilities.realLlmExtract) qa=$($health.capabilities.realLlmQa)"
if ($health.env) {
  $from = @()
  if ($health.env.fromProcess) { $from += ("process-env: " + ($health.env.fromProcess -join ',')) }
  if ($health.env.fromFile) { foreach ($f in $health.env.fromFile) { $from += ($f.file + ": " + ($f.keys -join ',')) } }
  if ($from.Count -eq 0) { $from = @('(no config found)') }
  Write-Host "[health] config source: $($from -join ' | ')"
}

# ---- 5. real minimal model call (only when credentials exist) ----
if ($health.hasCredentials) {
  Write-Host ""
  Write-Host "==== minimal real model call ====" -ForegroundColor Cyan
  & $node (Join-Path $root 'scripts\probe-minimal-llm.mjs')
  Write-Host ""
  Write-Host "If the probe above shows OK, the model is usable: open http://127.0.0.1:$port/" -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "[model] no credentials: the app is running, but extraction / method analysis / cited QA" -ForegroundColor Yellow
  Write-Host "        will explicitly report 'model not configured' rather than returning rule results." -ForegroundColor Yellow
  Write-Host "        Fill LLM_API_KEY in .env.local and run this script again to enable the model." -ForegroundColor Yellow
}
