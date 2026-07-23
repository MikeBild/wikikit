#!/usr/bin/env bash
# WikiKit SessionStart hook — load knowledge into a fresh coding-agent session.
#
# Prints the server-built compact, budgeted briefing. Full concept pages stay
# behind wikikit_search/wikikit_read and are fetched only when a task needs
# them.
#
# Generic lifecycle-hook contract:
#   - stdin is JSON ({"cwd":..., "session_id":..., "transcript_path":...}) — unused here.
#   - stdout is injected into the session.
#   - exit 0 ALWAYS. A knowledge base being down must never break a session,
#     so every failure path prints nothing and exits 0.
#
# Setup: see docs/coding-agent-integration.md
set -uo pipefail

# shellcheck disable=SC1091
[ -r "$HOME/.wikikit/env" ] && . "$HOME/.wikikit/env"

: "${WIKIKIT_URL:=http://127.0.0.1:4060}"
: "${WIKIKIT_SPACE:=default}"
: "${WIKIKIT_API_KEY:=}"
: "${WIKIKIT_BRIEFING_TOKENS:=1200}"

[ -n "$WIKIKIT_API_KEY" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

response=$(curl -s -m 5 --fail --get \
  "${WIKIKIT_URL}/v1/agent/briefing" \
  --data-urlencode "spaces=${WIKIKIT_SPACE}" \
  --data-urlencode "budget_tokens=${WIKIKIT_BRIEFING_TOKENS}" \
  -H "Authorization: Bearer ${WIKIKIT_API_KEY}" 2>/dev/null) || exit 0

briefing=$(printf '%s' "$response" | jq -r '.markdown // empty' 2>/dev/null) || exit 0
[ -n "$briefing" ] || exit 0
printf '%s\n' "$briefing"
