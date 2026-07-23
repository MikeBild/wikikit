# WikiKit UserPromptSubmit hook (Windows) — select task-relevant knowledge for THIS prompt.
#
# PowerShell 5.1 counterpart of wikikit-context.sh with the same contract:
#   - stdin is JSON ({"prompt":..., "cwd":..., "session_id":...}).
#   - stdout is injected into the session.
#   - exit 0 ALWAYS. Never exit 2: hosts treat that as "block this prompt".
#
# Runs on every prompt — keep it fast: short timeout, no retries.
#
# Setup: see docs/coding-agent-integration.md
$ErrorActionPreference = 'Stop'
try {
  $wikikitEnv = Join-Path $env:USERPROFILE '.wikikit\env.ps1'
  if (Test-Path -LiteralPath $wikikitEnv) { . $wikikitEnv }

  if (-not $env:WIKIKIT_URL) { $env:WIKIKIT_URL = 'http://127.0.0.1:4060' }
  if (-not $env:WIKIKIT_CONTEXT_TOKENS) { $env:WIKIKIT_CONTEXT_TOKENS = '1200' }
  if (-not $env:WIKIKIT_API_KEY) { exit 0 }

  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $prompt = [string]$payload.prompt
  if (-not $prompt) { exit 0 }
  if ($prompt.Length -gt 12000) { $prompt = $prompt.Substring(0, 12000) }

  $cwd = if ($payload.cwd) { [string]$payload.cwd } else { (Get-Location).Path }
  $projectHint = Split-Path -Leaf $cwd
  if ($projectHint.Length -gt 500) { $projectHint = $projectHint.Substring(0, 500) }

  $tokens = [int]$env:WIKIKIT_CONTEXT_TOKENS
  $primarySpace = $null
  $manifestPath = Join-Path $cwd '.wikikit\agent.json'
  if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.primary_space) { $primarySpace = [string]$manifest.primary_space }
    if ($manifest.budget_tokens) { $tokens = [int]$manifest.budget_tokens }
  }

  $body = @{ prompt = $prompt; budget_tokens = $tokens }
  if ($projectHint) { $body.project_hint = $projectHint }
  if ($primarySpace) { $body.primary_space = $primarySpace }
  $json = $body | ConvertTo-Json -Depth 8

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $response = Invoke-RestMethod -Uri "$($env:WIKIKIT_URL)/v1/agent/context" -Method Post -TimeoutSec 5 `
    -Headers @{ Authorization = "Bearer $($env:WIKIKIT_API_KEY)" } `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
  if ($response.markdown) { Write-Output $response.markdown }
} catch { }
exit 0
