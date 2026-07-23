# WikiKit agent hooks installer (Windows, PowerShell 5.1+).
#
# Wires the WikiKit lifecycle hooks (SessionStart briefing, UserPromptSubmit
# context, SessionEnd/Stop capture) into every coding-agent harness found on
# this machine: Claude Code, Codex, Cursor. Merge-never-clobber: existing hook
# entries are preserved and re-running is an upgrade.
#
#   powershell -ExecutionPolicy Bypass -c "irm __WIKIKIT_BASE_URL__/install.ps1 | iex"
#
# `iex` takes no arguments — configure via environment variables first:
#   $env:WIKIKIT_URL       server base URL (default: the serving host)
#   $env:WIKIKIT_API_KEY   wk_... key to store in ~\.wikikit\env.ps1
#   $env:WIKIKIT_SPACE     default space for briefing/capture
#   $env:WIKIKIT_YES = '1'        never prompt (keyless install is valid)
#   $env:WIKIKIT_NO_MCP = '1'     skip MCP registration/instructions
#   $env:WIKIKIT_UNINSTALL = '1'  remove hooks and wikikit hook entries
#
# This is NOT the repository's `bun run hooks:install` (git pre-push hooks for
# contributors) — this installs agent hooks for consumers of a WikiKit server.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:BaseUrl = if ($env:WIKIKIT_URL) { $env:WIKIKIT_URL.TrimEnd('/') } else { '__WIKIKIT_BASE_URL__' }
$script:WikikitDir = Join-Path $env:USERPROFILE '.wikikit'
$script:HooksDir = Join-Path $script:WikikitDir 'hooks'
$script:HookScripts = @('wikikit-briefing.ps1', 'wikikit-context.ps1', 'wikikit-capture.ps1')
$script:WikikitMarker = '[\\/]\.wikikit[\\/]hooks[\\/]'

function Say([string]$Message) { Write-Host "wikikit: $Message" }

function Get-HookCommand([string]$ScriptName) {
  $path = Join-Path $script:HooksDir $ScriptName
  # Plain-string invocation that works from PowerShell, cmd and Git Bash alike,
  # so it survives whichever shell the harness uses on Windows.
  "powershell -NoProfile -ExecutionPolicy Bypass -File `"$path`""
}

function Read-JsonFile([string]$Path) {
  if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -gt 0) {
    Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } else {
    New-Object PSObject
  }
}

function Save-JsonFile([string]$Path, $Object) {
  # -Depth 32: PowerShell 5.1 silently flattens nodes past the default depth 2.
  $json = $Object | ConvertTo-Json -Depth 32
  $backup = "$Path.wikikit-backup"
  if ((Test-Path -LiteralPath $Path) -and -not (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $Path -Destination $backup
  }
  $tmp = "$Path.wikikit-tmp"
  Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $Path -Force
  Say "updated $Path"
}

function Ensure-Property($Object, [string]$Name, $Default) {
  if (-not $Object.PSObject.Properties[$Name]) {
    Add-Member -InputObject $Object -NotePropertyName $Name -NotePropertyValue $Default
  }
}

function Test-HasWikikitEntry($Entries, [bool]$Nested) {
  foreach ($entry in @($Entries)) {
    if ($null -eq $entry) { continue }
    if ($Nested) {
      foreach ($inner in @($entry.hooks)) {
        if ($inner -and "$($inner.command)" -match $script:WikikitMarker) { return $true }
      }
    } elseif ("$($entry.command)" -match $script:WikikitMarker) { return $true }
  }
  return $false
}

# Claude Code and Codex share the nested entry shape; only the terminal event
# name differs (SessionEnd vs Stop — Codex has no SessionEnd).
function Merge-NestedHooks([string]$Path, [string]$EndEvent) {
  $cfg = Read-JsonFile $Path
  Ensure-Property $cfg 'hooks' (New-Object PSObject)
  $changed = $false
  $events = @(
    @{ Name = 'SessionStart'; Entry = [pscustomobject]@{
        matcher = 'startup|resume|clear|compact'
        hooks = @([pscustomobject]@{ type = 'command'; command = (Get-HookCommand 'wikikit-briefing.ps1'); timeout = 30 }) } },
    @{ Name = 'UserPromptSubmit'; Entry = [pscustomobject]@{
        hooks = @([pscustomobject]@{ type = 'command'; command = (Get-HookCommand 'wikikit-context.ps1'); timeout = 30 }) } },
    @{ Name = $EndEvent; Entry = [pscustomobject]@{
        hooks = @([pscustomobject]@{ type = 'command'; command = (Get-HookCommand 'wikikit-capture.ps1'); timeout = 60 }) } }
  )
  foreach ($event in $events) {
    Ensure-Property $cfg.hooks $event.Name @()
    $existing = @($cfg.hooks.($event.Name))
    if (-not (Test-HasWikikitEntry $existing $true)) {
      $cfg.hooks.($event.Name) = $existing + @($event.Entry)
      $changed = $true
    }
  }
  if ($changed) { Save-JsonFile $Path $cfg } else { Say "$Path already wired — unchanged" }
}

function Merge-CursorHooks([string]$Path) {
  $cfg = Read-JsonFile $Path
  Ensure-Property $cfg 'version' 1
  Ensure-Property $cfg 'hooks' (New-Object PSObject)
  $changed = $false
  $events = @(
    @{ Name = 'sessionStart'; Script = 'wikikit-briefing.ps1' },
    @{ Name = 'beforeSubmitPrompt'; Script = 'wikikit-context.ps1' },
    @{ Name = 'stop'; Script = 'wikikit-capture.ps1' }
  )
  foreach ($event in $events) {
    Ensure-Property $cfg.hooks $event.Name @()
    $existing = @($cfg.hooks.($event.Name))
    if (-not (Test-HasWikikitEntry $existing $false)) {
      $cfg.hooks.($event.Name) = $existing + @([pscustomobject]@{ command = (Get-HookCommand $event.Script) })
      $changed = $true
    }
  }
  if ($changed) { Save-JsonFile $Path $cfg } else { Say "$Path already wired — unchanged" }
}

function Remove-WikikitHooks([string]$Path, [bool]$Nested) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $cfg = Read-JsonFile $Path
  if (-not $cfg.PSObject.Properties['hooks']) { return }
  $changed = $false
  foreach ($prop in @($cfg.hooks.PSObject.Properties)) {
    $kept = @()
    foreach ($entry in @($prop.Value)) {
      if ($null -eq $entry) { continue }
      $isWikikit = if ($Nested) { Test-HasWikikitEntry @($entry) $true } else { "$($entry.command)" -match $script:WikikitMarker }
      if ($isWikikit) { $changed = $true } else { $kept += $entry }
    }
    $cfg.hooks.($prop.Name) = $kept
  }
  if ($changed) { Save-JsonFile $Path $cfg }
}

function Wire-CodexToml {
  $toml = Join-Path $env:USERPROFILE '.codex\config.toml'
  if (-not (Test-Path -LiteralPath $toml)) { New-Item -ItemType File -Path $toml -Force | Out-Null }
  $content = Get-Content -LiteralPath $toml -Raw
  if ($null -eq $content) { $content = '' }
  if ($content -notmatch '(?m)^\[features\]') {
    Add-Content -LiteralPath $toml -Value "`n[features]`nhooks = true"
    Say "enabled [features] hooks in $toml"
  } elseif ($content -notmatch '(?m)^hooks\s*=\s*true') {
    Say "note: $toml has a [features] table — ensure it contains 'hooks = true' (recent Codex versions enable hooks by default)"
  }
  if ($env:WIKIKIT_NO_MCP -eq '1') { return }
  if ($content -notmatch '(?m)^\[mcp_servers\.wikikit\]') {
    Add-Content -LiteralPath $toml -Value "`n[mcp_servers.wikikit]`nurl = `"$($script:BaseUrl)/mcp`"`nbearer_token_env_var = `"WIKIKIT_API_KEY`""
    Say "registered WikiKit MCP server in $toml"
  }
}

function Write-EnvFile([string]$Key, [string]$Space) {
  # Sourced by every hook; each line is guarded so a variable already set in
  # the environment always wins over the stored value.
  $envFile = Join-Path $script:WikikitDir 'env.ps1'
  $stored = @{}
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match "WIKIKIT_(\w+)\s*=\s*'([^']*)'") { $stored[$Matches[1]] = $Matches[2] }
    }
  }
  $stored['URL'] = $script:BaseUrl
  if ($Key) { $stored['API_KEY'] = $Key }
  if ($Space) { $stored['SPACE'] = $Space }
  $lines = foreach ($name in @($stored.Keys | Sort-Object)) {
    "if (-not `$env:WIKIKIT_$name) { `$env:WIKIKIT_$name = '$($stored[$name])' }"
  }
  Set-Content -LiteralPath $envFile -Value ($lines -join "`r`n") -Encoding UTF8
  Say "wrote $envFile (environment variables always win over stored values)"
}

function Invoke-WikikitInstall {
  if ($env:WIKIKIT_UNINSTALL -eq '1') {
    Remove-WikikitHooks (Join-Path $env:USERPROFILE '.claude\settings.json') $true
    Remove-WikikitHooks (Join-Path $env:USERPROFILE '.codex\hooks.json') $true
    Remove-WikikitHooks (Join-Path $env:USERPROFILE '.cursor\hooks.json') $false
    if (Test-Path -LiteralPath $script:HooksDir) { Remove-Item -LiteralPath $script:HooksDir -Recurse -Force }
    Say 'removed ~\.wikikit\hooks'
    Say 'left in place (may hold your key / your edits): ~\.wikikit\env.ps1, [features]/[mcp_servers.wikikit] in ~\.codex\config.toml'
    Say 'uninstall complete'
    return
  }

  New-Item -ItemType Directory -Path $script:HooksDir -Force | Out-Null
  foreach ($name in $script:HookScripts) {
    Invoke-RestMethod -Uri "$($script:BaseUrl)/install/hooks/$name" -OutFile (Join-Path $script:HooksDir $name)
  }
  Say 'installed hook scripts to ~\.wikikit\hooks'

  $key = $env:WIKIKIT_API_KEY
  if (-not $key -and $env:WIKIKIT_YES -ne '1' -and [Environment]::UserInteractive) {
    $key = Read-Host 'WikiKit API key (wk_..., empty to skip)'
  }
  if (-not $key) { Say 'no API key set — hooks stay dormant until you set one in ~\.wikikit\env.ps1' }
  Write-EnvFile $key $env:WIKIKIT_SPACE

  $found = $false
  if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.claude')) {
    $found = $true
    Merge-NestedHooks (Join-Path $env:USERPROFILE '.claude\settings.json') 'SessionEnd'
  }
  if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.codex')) {
    $found = $true
    # Codex has no SessionEnd event; the terminal event is Stop.
    Merge-NestedHooks (Join-Path $env:USERPROFILE '.codex\hooks.json') 'Stop'
    Wire-CodexToml
  }
  if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.cursor')) {
    $found = $true
    Merge-CursorHooks (Join-Path $env:USERPROFILE '.cursor\hooks.json')
  }
  if (-not $found) { Say 'no harness found (~\.claude, ~\.codex, ~\.cursor) — hooks are staged; re-run after installing one' }

  if ($env:WIKIKIT_NO_MCP -ne '1') {
    Say 'MCP registration (printed, not executed — secrets stay out of configs):'
    if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.claude')) {
      Write-Host "  Claude Code:`n    claude mcp add --scope user --transport http wikikit `"$($script:BaseUrl)/mcp`" --header `"Authorization: Bearer <your wk_... key>`""
    }
    if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.cursor')) {
      Write-Host "  Cursor (~\.cursor\mcp.json, mcpServers entry):`n    `"wikikit`": { `"url`": `"$($script:BaseUrl)/mcp`", `"headers`": { `"Authorization`": `"Bearer <your wk_... key>`" } }"
    }
  }
  Say 'done. Re-running this installer is safe (idempotent) and upgrades the hook scripts.'
}

Invoke-WikikitInstall
