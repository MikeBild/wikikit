# WikiKit SessionStart hook (Windows) — load knowledge into a fresh coding-agent session.
#
# PowerShell 5.1 counterpart of wikikit-briefing.sh with the same contract:
#   - stdout is injected into the session.
#   - exit 0 ALWAYS. A knowledge base being down must never break a session.
#     Never exit 2: hosts treat that as "block this event".
#
# Setup: see docs/coding-agent-integration.md
$ErrorActionPreference = 'Stop'
try {
  $wikikitEnv = Join-Path $env:USERPROFILE '.wikikit\env.ps1'
  if (Test-Path -LiteralPath $wikikitEnv) { . $wikikitEnv }

  if (-not $env:WIKIKIT_URL) { $env:WIKIKIT_URL = 'http://127.0.0.1:4060' }
  if (-not $env:WIKIKIT_SPACE) { $env:WIKIKIT_SPACE = 'default' }
  if (-not $env:WIKIKIT_BRIEFING_TOKENS) { $env:WIKIKIT_BRIEFING_TOKENS = '1200' }
  if (-not $env:WIKIKIT_API_KEY) { exit 0 }

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $uri = '{0}/v1/agent/briefing?spaces={1}&budget_tokens={2}' -f `
    $env:WIKIKIT_URL, [uri]::EscapeDataString($env:WIKIKIT_SPACE), $env:WIKIKIT_BRIEFING_TOKENS
  $response = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 5 `
    -Headers @{ Authorization = "Bearer $($env:WIKIKIT_API_KEY)" }
  if ($response.markdown) { Write-Output $response.markdown }
} catch { }
exit 0
