# WikiKit SessionEnd/Stop hook (Windows) — save what the session taught.
#
# PowerShell 5.1 counterpart of wikikit-capture.sh with the same contract:
#   - stdin is JSON ({"cwd":..., "session_id":..., "transcript_path":...}).
#   - exit 0 ALWAYS, print nothing. Set WIKIKIT_HOOK_DEBUG=1 to log to
#     ~\.wikikit\hook.log instead of guessing.
#
# The transcript itself is never archived: it is distilled and dropped.
#
# Setup: see docs/coding-agent-integration.md
$ErrorActionPreference = 'Stop'

function Write-WikikitLog([string]$Message) {
  if ($env:WIKIKIT_HOOK_DEBUG -ne '1') { return }
  try {
    $dir = Join-Path $env:USERPROFILE '.wikikit'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    Add-Content -LiteralPath (Join-Path $dir 'hook.log') -Value "$stamp wikikit-capture: $Message"
  } catch { }
}

try {
  $wikikitEnv = Join-Path $env:USERPROFILE '.wikikit\env.ps1'
  if (Test-Path -LiteralPath $wikikitEnv) { . $wikikitEnv }

  if (-not $env:WIKIKIT_URL) { $env:WIKIKIT_URL = 'http://127.0.0.1:4060' }
  if (-not $env:WIKIKIT_SPACE) { $env:WIKIKIT_SPACE = 'default' }
  if (-not $env:WIKIKIT_API_KEY) { exit 0 }

  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $transcriptPath = [string]$payload.transcript_path
  if (-not $transcriptPath -or -not (Test-Path -LiteralPath $transcriptPath)) {
    Write-WikikitLog 'no readable transcript_path'
    exit 0
  }

  # Hosts write JSONL, one message per line. Flatten to "role: text" lines and
  # keep the TAIL: corrections skew late, so the head is the part safe to drop.
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in [System.IO.File]::ReadLines($transcriptPath)) {
    if (-not $line.Trim()) { continue }
    try { $msg = $line | ConvertFrom-Json } catch { continue }
    $role = if ($msg.message -and $msg.message.role) { $msg.message.role }
            elseif ($msg.role) { $msg.role } else { '?' }
    $content = if ($msg.message -and $msg.message.PSObject.Properties['content']) { $msg.message.content }
               else { $msg.content }
    $text = $null
    if ($content -is [string]) { $text = $content }
    elseif ($content -is [System.Array]) {
      $parts = @($content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text })
      if ($parts.Count -gt 0) { $text = $parts -join "`n" }
    }
    if ($text) { $lines.Add("${role}: $text") }
  }

  $transcript = $lines -join "`n"
  if ($transcript.Length -gt 200000) { $transcript = $transcript.Substring($transcript.Length - 200000) }
  if (-not $transcript) { Write-WikikitLog 'empty transcript'; exit 0 }

  $json = @{ transcript = $transcript } | ConvertTo-Json -Depth 4

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $space = [uri]::EscapeDataString($env:WIKIKIT_SPACE)
  try {
    $response = Invoke-RestMethod -Uri "$($env:WIKIKIT_URL)/v1/spaces/$space/agent/sessions" `
      -Method Post -TimeoutSec 60 `
      -Headers @{ Authorization = "Bearer $($env:WIKIKIT_API_KEY)" } `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
    Write-WikikitLog ("status={0} learnings={1}" -f $response.status, $response.learnings)
  } catch {
    Write-WikikitLog "capture request failed: $($_.Exception.Message)"
  }
} catch { }
exit 0
