#!/usr/bin/env bash
# WikiKit SessionStart hook — load knowledge into a fresh coding-agent session.
#
# Prints the space's concept INDEX plus a grounding rule. Deliberately an index
# and not the pages themselves: the agent has wikikit_search/wikikit_read over
# MCP to fetch what it needs, and preloading whole pages would burn the context
# window on knowledge the session may never touch.
#
# Contract with Claude Code / Codex:
#   - stdin is JSON ({"cwd":..., "session_id":..., "transcript_path":...}) — unused here.
#   - stdout is injected into the session.
#   - exit 0 ALWAYS. A knowledge base being down must never break a session,
#     so every failure path prints nothing and exits 0.
#
# Setup: see docs/coding-agent-integration.md
set -uo pipefail

: "${WIKIKIT_URL:=http://127.0.0.1:4060}"
: "${WIKIKIT_SPACE:=default}"
: "${WIKIKIT_API_KEY:=}"

[ -n "$WIKIKIT_API_KEY" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

response=$(curl -s -m 5 --fail \
  "${WIKIKIT_URL}/v1/spaces/${WIKIKIT_SPACE}/concepts?limit=100" \
  -H "Authorization: Bearer ${WIKIKIT_API_KEY}" 2>/dev/null) || exit 0

index=$(printf '%s' "$response" | jq -r '.items[]? | "- \(.slug) — \(.title): \(.summary)"' 2>/dev/null) || exit 0

# An empty knowledge base has nothing to say. Staying silent beats injecting a
# header with no content under it.
[ -n "$index" ] || exit 0

cat <<EOF
# WikiKit knowledge — space \`${WIKIKIT_SPACE}\`

These concepts are reviewed, cited knowledge for this project. For anything they
cover, look it up instead of guessing: call \`wikikit_search\`, or \`wikikit_read\`
with a slug below. If a lookup returns nothing, say so — do not invent project
internals.

$index

To record something the user teaches you, call \`wikikit_ingest\` or
\`wikikit_propose\`. That stages a proposal for human review; it does not
publish. Never tell the user their knowledge is live — it is proposed.
EOF
