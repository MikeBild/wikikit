#!/usr/bin/env bash
# WikiKit UserPromptSubmit hook — select task-relevant knowledge for THIS prompt.
#
# Posts the prompt to POST /v1/agent/context; the server picks relevant spaces
# and answers a compact, budgeted briefing. This is the dynamic half of the
# lifecycle pair: SessionStart grounds the session once, this hook re-grounds
# every turn. Full concept pages stay behind wikikit_search/wikikit_read.
#
# Reads the optional project manifest `.wikikit/agent.json` (primary_space,
# budget_tokens) when the host passes a cwd.
#
# Generic lifecycle-hook contract:
#   - stdin is JSON ({"prompt":..., "cwd":..., "session_id":...}).
#   - stdout is injected into the session.
#   - exit 0 ALWAYS. A knowledge base being down must never break a session,
#     so every failure path prints nothing and exits 0. Never exit 2: hosts
#     treat that as "block this prompt".
#
# Runs on every prompt — keep it fast: short curl timeouts, no retries.
#
# Setup: see docs/coding-agent-integration.md
set -uo pipefail

# shellcheck disable=SC1091
[ -r "$HOME/.wikikit/env" ] && . "$HOME/.wikikit/env"

: "${WIKIKIT_URL:=http://127.0.0.1:4060}"
: "${WIKIKIT_API_KEY:=}"
: "${WIKIKIT_CONTEXT_TOKENS:=1200}"

[ -n "$WIKIKIT_API_KEY" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat 2>/dev/null) || exit 0
prompt=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null | head -c 12000)
[ -n "$prompt" ] || exit 0
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)
project_hint=$(basename "${cwd:-$PWD}" 2>/dev/null | head -c 500) || project_hint=""

primary_space=""
manifest="${cwd:-$PWD}/.wikikit/agent.json"
if [ -r "$manifest" ]; then
  primary_space=$(jq -r '.primary_space // empty' "$manifest" 2>/dev/null) || primary_space=""
  manifest_tokens=$(jq -r '.budget_tokens // empty' "$manifest" 2>/dev/null) || manifest_tokens=""
  [ -n "$manifest_tokens" ] && WIKIKIT_CONTEXT_TOKENS="$manifest_tokens"
fi

body=$(jq -n --arg p "$prompt" --arg h "$project_hint" --arg ps "$primary_space" \
  --argjson b "$WIKIKIT_CONTEXT_TOKENS" \
  '{prompt: $p, budget_tokens: $b}
   + (if $h != "" then {project_hint: $h} else {} end)
   + (if $ps != "" then {primary_space: $ps} else {} end)' 2>/dev/null) || exit 0

response=$(curl -s -m 5 --connect-timeout 2 --fail -X POST \
  "${WIKIKIT_URL}/v1/agent/context" \
  -H "Authorization: Bearer ${WIKIKIT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$body" 2>/dev/null) || exit 0

markdown=$(printf '%s' "$response" | jq -r '.markdown // empty' 2>/dev/null) || exit 0
[ -n "$markdown" ] || exit 0
printf '%s\n' "$markdown"
