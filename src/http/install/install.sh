#!/bin/sh
# WikiKit agent hooks installer (macOS / Linux).
#
# Wires the WikiKit lifecycle hooks (SessionStart briefing, UserPromptSubmit
# context, SessionEnd/Stop capture) into every coding-agent harness found on
# this machine: Claude Code, Codex, Cursor. Merge-never-clobber: existing hook
# entries are preserved, re-running is an upgrade, --uninstall removes exactly
# what this installer added.
#
#   curl -fsSL __WIKIKIT_BASE_URL__/install.sh | sh
#   curl -fsSL __WIKIKIT_BASE_URL__/install.sh | sh -s -- --yes --key wk_...
#
# This is NOT the repository's `bun run hooks:install` (git pre-push hooks for
# contributors) — this installs agent hooks for consumers of a WikiKit server.
#
# Strict POSIX sh (dash/ash-safe). Everything lives in functions; the trailing
# `main "$@"` guard means a truncated download defines functions but runs
# nothing.
set -u

WIKIKIT_DEFAULT_URL="__WIKIKIT_BASE_URL__"
HOOK_SCRIPTS="wikikit-briefing.sh wikikit-context.sh wikikit-capture.sh"

say() { printf 'wikikit: %s\n' "$1"; }
warn() { printf 'wikikit: warning: %s\n' "$1" >&2; }
err() {
  printf 'wikikit: error: %s\n' "$1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "need '$1' (command not found)"
}

# curl with wget fallback; enforce TLS >= 1.2 for https targets only, so a
# local http://127.0.0.1 server stays reachable for testing.
download() {
  dl_url=$1
  dl_dest=$2
  if command -v curl >/dev/null 2>&1; then
    case "$dl_url" in
      https://*) curl -fsSL --proto '=https' --tlsv1.2 "$dl_url" -o "$dl_dest" ;;
      *) curl -fsSL "$dl_url" -o "$dl_dest" ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dl_dest" "$dl_url"
  else
    err "need curl or wget to download hook scripts"
  fi
}

# --- JSON merging (jq) -------------------------------------------------------
# The .sh hooks themselves require jq (they self-disable without it), so jq is
# also the natural requirement for touching harness configs: wiring hooks that
# cannot run would only produce silent no-ops.

# Claude Code and Codex share the nested entry shape; only the terminal event
# name differs (SessionEnd vs Stop).
nested_merge_prog() {
  nm_end_event=$1
  cat <<PROG
def wk(cmd; t): {type: "command", command: (\$home + "/.wikikit/hooks/" + cmd), timeout: t};
def haswk(arr): ([arr[]? | (.hooks[]? | .command // "") | select(contains("/.wikikit/hooks/"))] | length) > 0;
.hooks = (.hooks // {})
| (if haswk(.hooks.SessionStart // []) then . else
     .hooks.SessionStart = ((.hooks.SessionStart // []) + [{matcher: "startup|resume|clear|compact", hooks: [wk("wikikit-briefing.sh"; 30)]}]) end)
| (if haswk(.hooks.UserPromptSubmit // []) then . else
     .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + [{hooks: [wk("wikikit-context.sh"; 30)]}]) end)
| (if haswk(.hooks.${nm_end_event} // []) then . else
     .hooks.${nm_end_event} = ((.hooks.${nm_end_event} // []) + [{hooks: [wk("wikikit-capture.sh"; 60)]}]) end)
PROG
}

# shellcheck disable=SC2016 # jq program — $home is a jq variable, not shell
CURSOR_MERGE_PROG='
def wkc(cmd): {command: ($home + "/.wikikit/hooks/" + cmd)};
def haswk(arr): ([arr[]? | (.command // "") | select(contains("/.wikikit/hooks/"))] | length) > 0;
.version = (.version // 1)
| .hooks = (.hooks // {})
| (if haswk(.hooks.sessionStart // []) then . else
     .hooks.sessionStart = ((.hooks.sessionStart // []) + [wkc("wikikit-briefing.sh")]) end)
| (if haswk(.hooks.beforeSubmitPrompt // []) then . else
     .hooks.beforeSubmitPrompt = ((.hooks.beforeSubmitPrompt // []) + [wkc("wikikit-context.sh")]) end)
| (if haswk(.hooks.stop // []) then . else
     .hooks.stop = ((.hooks.stop // []) + [wkc("wikikit-capture.sh")]) end)
'

NESTED_REMOVE_PROG='
if .hooks then
  .hooks |= with_entries(.value |= [.[] | select((([.hooks[]? | .command // ""] | join(" ")) | contains("/.wikikit/hooks/")) | not)])
else . end
'

CURSOR_REMOVE_PROG='
if .hooks then
  .hooks |= with_entries(.value |= [.[] | select(((.command // "") | contains("/.wikikit/hooks/")) | not)])
else . end
'

# merge_json <file> <jq-program>: read → merge in memory → temp file in the
# same directory → atomic mv. First real change keeps a one-time backup.
# Re-running with nothing to change leaves the file byte-identical.
merge_json() {
  mj_file=$1
  mj_prog=$2
  [ -s "$mj_file" ] || printf '{}\n' >"$mj_file" || return 1
  mj_tmp=$(mktemp "${mj_file}.wikikit.XXXXXX") || return 1
  if ! jq --arg home "$HOME" "$mj_prog" "$mj_file" >"$mj_tmp" 2>/dev/null; then
    rm -f "$mj_tmp"
    warn "$mj_file is not valid JSON — left untouched"
    return 1
  fi
  if cmp -s "$mj_file" "$mj_tmp"; then
    rm -f "$mj_tmp"
    say "$mj_file already wired — unchanged"
  else
    [ -f "${mj_file}.wikikit-backup" ] || cp "$mj_file" "${mj_file}.wikikit-backup"
    mv "$mj_tmp" "$mj_file"
    say "updated $mj_file"
  fi
  return 0
}

# --- env file ----------------------------------------------------------------
# ~/.wikikit/env is sourced by every hook. Lines use ${VAR:-value} so a value
# exported in the caller's environment always wins over the stored one.
set_env_var() {
  se_name=$1
  se_value=$2
  se_file="$HOME/.wikikit/env"
  touch "$se_file" && chmod 600 "$se_file"
  se_tmp=$(mktemp "${se_file}.XXXXXX") || return 1
  grep -v "^export ${se_name}=" "$se_file" >"$se_tmp" 2>/dev/null || true
  # shellcheck disable=SC2016 # the ${VAR:-...} guard must land literally in the env file
  printf 'export %s="${%s:-%s}"\n' "$se_name" "$se_name" "$se_value" >>"$se_tmp"
  mv "$se_tmp" "$se_file" && chmod 600 "$se_file"
}

# --- codex config.toml -------------------------------------------------------
# Append-only, never rewrites existing user TOML. Top-level tables are
# order-independent, so appending at EOF is safe.
wire_codex_toml() {
  wc_toml="$HOME/.codex/config.toml"
  touch "$wc_toml"
  if ! grep -q '^\[features\]' "$wc_toml"; then
    printf '\n[features]\nhooks = true\n' >>"$wc_toml"
    say "enabled [features] hooks in $wc_toml"
  elif ! grep -q '^hooks[[:space:]]*=[[:space:]]*true' "$wc_toml"; then
    say "note: $wc_toml has a [features] table — ensure it contains 'hooks = true' (recent Codex versions enable hooks by default)"
  fi
  if [ "$NO_MCP" = 1 ]; then
    return 0
  fi
  if ! grep -q '^\[mcp_servers\.wikikit\]' "$wc_toml"; then
    printf '\n[mcp_servers.wikikit]\nurl = "%s/mcp"\nbearer_token_env_var = "WIKIKIT_API_KEY"\n' "$WIKIKIT_URL" >>"$wc_toml"
    say "registered WikiKit MCP server in $wc_toml"
  fi
}

print_mcp_instructions() {
  [ "$NO_MCP" = 1 ] && return 0
  printf '\n'
  say "MCP registration (printed, not executed — secrets stay out of configs):"
  if [ -d "$HOME/.claude" ]; then
    # shellcheck disable=SC2016 # printed instruction — the user's shell expands $WIKIKIT_API_KEY
    printf '  Claude Code:\n    claude mcp add --scope user --transport http wikikit "%s/mcp" --header "Authorization: Bearer $WIKIKIT_API_KEY"\n' "$WIKIKIT_URL"
  fi
  if [ -d "$HOME/.cursor" ]; then
    printf '  Cursor (~/.cursor/mcp.json, mcpServers entry):\n    "wikikit": { "url": "%s/mcp", "headers": { "Authorization": "Bearer <your wk_... key>" } }\n' "$WIKIKIT_URL"
  fi
}

print_manual_snippets() {
  say "manual wiring (jq missing) — merge these yourself:"
  printf '  ~/.claude/settings.json + ~/.codex/hooks.json (SessionEnd is named Stop for Codex):\n'
  printf '    {"hooks":{"SessionStart":[{"matcher":"startup|resume|clear|compact","hooks":[{"type":"command","command":"%s/.wikikit/hooks/wikikit-briefing.sh","timeout":30}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"%s/.wikikit/hooks/wikikit-context.sh","timeout":30}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"%s/.wikikit/hooks/wikikit-capture.sh","timeout":60}]}]}}\n' "$HOME" "$HOME" "$HOME"
  printf '  ~/.cursor/hooks.json:\n'
  printf '    {"version":1,"hooks":{"sessionStart":[{"command":"%s/.wikikit/hooks/wikikit-briefing.sh"}],"beforeSubmitPrompt":[{"command":"%s/.wikikit/hooks/wikikit-context.sh"}],"stop":[{"command":"%s/.wikikit/hooks/wikikit-capture.sh"}]}}\n' "$HOME" "$HOME" "$HOME"
}

do_uninstall() {
  if command -v jq >/dev/null 2>&1; then
    [ -f "$HOME/.claude/settings.json" ] && merge_json "$HOME/.claude/settings.json" "$NESTED_REMOVE_PROG"
    [ -f "$HOME/.codex/hooks.json" ] && merge_json "$HOME/.codex/hooks.json" "$NESTED_REMOVE_PROG"
    [ -f "$HOME/.cursor/hooks.json" ] && merge_json "$HOME/.cursor/hooks.json" "$CURSOR_REMOVE_PROG"
  else
    warn "jq missing — remove entries containing '/.wikikit/hooks/' from ~/.claude/settings.json, ~/.codex/hooks.json and ~/.cursor/hooks.json yourself"
  fi
  rm -rf "$HOME/.wikikit/hooks"
  say "removed ~/.wikikit/hooks"
  say "left in place (may hold your key / your edits): ~/.wikikit/env, [features]/[mcp_servers.wikikit] in ~/.codex/config.toml"
  say "uninstall complete"
}

usage() {
  cat <<'USAGE'
WikiKit agent hooks installer

  curl -fsSL <wikikit>/install.sh | sh -s -- [options]

Options:
  --url <base>    WikiKit server base URL (default: the serving host)
  --key <wk_...>  API key to store in ~/.wikikit/env (chmod 600)
  --space <slug>  Default space for briefing/capture (WIKIKIT_SPACE)
  --yes           Non-interactive: never prompt (keyless install is valid;
                  hooks self-disable until a key is set in ~/.wikikit/env)
  --no-mcp        Skip MCP server registration/instructions
  --uninstall     Remove installed hooks and wikikit hook entries
  -h, --help      This help
USAGE
}

main() {
  WIKIKIT_URL="${WIKIKIT_URL:-$WIKIKIT_DEFAULT_URL}"
  wikikit_key="${WIKIKIT_API_KEY:-}"
  wikikit_space="${WIKIKIT_SPACE:-}"
  ASSUME_YES=0
  NO_MCP=0
  UNINSTALL=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --url) WIKIKIT_URL=$2; shift 2 ;;
      --key) wikikit_key=$2; shift 2 ;;
      --space) wikikit_space=$2; shift 2 ;;
      --yes) ASSUME_YES=1; shift ;;
      --no-mcp) NO_MCP=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) err "unknown option '$1' (see --help)" ;;
    esac
  done
  WIKIKIT_URL=${WIKIKIT_URL%/}

  case "$(uname -s 2>/dev/null || true)" in
    MINGW* | MSYS* | CYGWIN*)
      err "on Windows use: powershell -ExecutionPolicy Bypass -c \"irm ${WIKIKIT_URL}/install.ps1 | iex\"" ;;
  esac

  if [ "$UNINSTALL" = 1 ]; then
    do_uninstall
    exit 0
  fi

  need_cmd mktemp
  need_cmd grep

  mkdir -p "$HOME/.wikikit/hooks" || err "cannot create ~/.wikikit/hooks"

  for wk_script in $HOOK_SCRIPTS; do
    download "${WIKIKIT_URL}/install/hooks/${wk_script}" "$HOME/.wikikit/hooks/${wk_script}.tmp" ||
      err "download failed: ${WIKIKIT_URL}/install/hooks/${wk_script}"
    # Defensive CRLF strip: a transcoding proxy must not produce 'bad interpreter: /bin/sh^M'.
    tr -d '\r' <"$HOME/.wikikit/hooks/${wk_script}.tmp" >"$HOME/.wikikit/hooks/${wk_script}"
    rm -f "$HOME/.wikikit/hooks/${wk_script}.tmp"
    chmod 755 "$HOME/.wikikit/hooks/${wk_script}"
  done
  say "installed hook scripts to ~/.wikikit/hooks"

  if [ -z "$wikikit_key" ] && [ "$ASSUME_YES" = 0 ] && [ -e /dev/tty ]; then
    # stdin belongs to the pipe (`curl | sh`), so prompts must use the tty.
    printf 'WikiKit API key (wk_..., empty to skip): ' >/dev/tty
    IFS= read -r wikikit_key </dev/tty || wikikit_key=""
  fi

  set_env_var WIKIKIT_URL "$WIKIKIT_URL"
  if [ -n "$wikikit_key" ]; then
    set_env_var WIKIKIT_API_KEY "$wikikit_key"
  else
    say "no API key set — hooks stay dormant until you add: export WIKIKIT_API_KEY=\"wk_...\" to ~/.wikikit/env"
  fi
  [ -n "$wikikit_space" ] && set_env_var WIKIKIT_SPACE "$wikikit_space"
  say "wrote ~/.wikikit/env (chmod 600; environment variables always win over stored values)"

  found_harness=0
  if command -v jq >/dev/null 2>&1; then
    if [ -d "$HOME/.claude" ]; then
      found_harness=1
      merge_json "$HOME/.claude/settings.json" "$(nested_merge_prog SessionEnd)" || true
    fi
    if [ -d "$HOME/.codex" ]; then
      found_harness=1
      # Codex has no SessionEnd event; the terminal event is Stop.
      merge_json "$HOME/.codex/hooks.json" "$(nested_merge_prog Stop)" || true
      wire_codex_toml
    fi
    if [ -d "$HOME/.cursor" ]; then
      found_harness=1
      merge_json "$HOME/.cursor/hooks.json" "$CURSOR_MERGE_PROG" || true
    fi
    [ "$found_harness" = 1 ] || say "no harness found (~/.claude, ~/.codex, ~/.cursor) — hooks are staged in ~/.wikikit/hooks; re-run after installing one"
  else
    warn "jq is not installed — it is required by the hooks themselves AND for config wiring."
    warn "install it (macOS: brew install jq | Debian/Ubuntu: sudo apt-get install jq | Fedora: sudo dnf install jq | Alpine: apk add jq) and re-run this installer."
    print_manual_snippets
  fi

  print_mcp_instructions
  printf '\n'
  say "done. Re-running this installer is safe (idempotent) and upgrades the hook scripts."
}

main "$@" || exit 1
