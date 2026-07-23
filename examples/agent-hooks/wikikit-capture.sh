#!/usr/bin/env bash
# WikiKit SessionEnd/Stop hook — save what the session taught.
#
# Posts the transcript to POST /v1/spaces/{space}/agent/sessions. The server
# distils ONLY durable rules a human explicitly taught or corrected; a routine
# session correctly yields `no_learnings` and writes nothing. Anything found is
# staged as a ChangeProposal — a human approves it, this hook never publishes.
#
# The transcript itself is never archived: it is distilled and dropped.
#
# Generic lifecycle-hook contract:
#   - stdin is JSON ({"cwd":..., "session_id":..., "transcript_path":...}).
#   - exit 0 ALWAYS, print nothing. This fires as the session ends; a hook that
#     errors or chats there is pure noise. Set WIKIKIT_HOOK_DEBUG=1 to log to
#     ~/.wikikit/hook.log instead of guessing.
#
# Setup: see docs/coding-agent-integration.md
set -uo pipefail

# shellcheck disable=SC1091
[ -r "$HOME/.wikikit/env" ] && . "$HOME/.wikikit/env"

: "${WIKIKIT_URL:=http://127.0.0.1:4060}"
: "${WIKIKIT_SPACE:=default}"
: "${WIKIKIT_API_KEY:=}"
: "${WIKIKIT_HOOK_DEBUG:=0}"

log() {
  [ "$WIKIKIT_HOOK_DEBUG" = "1" ] || return 0
  mkdir -p "$HOME/.wikikit" 2>/dev/null || return 0
  printf '%s wikikit-capture: %s\n' "$(date -u +%FT%TZ)" "$1" >>"$HOME/.wikikit/hook.log" 2>/dev/null || true
}

[ -n "$WIKIKIT_API_KEY" ] || exit 0
command -v jq >/dev/null 2>&1 || { log "jq not installed"; exit 0; }

payload=$(cat 2>/dev/null) || exit 0
transcript_path=$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)
if [ -z "$transcript_path" ] || [ ! -r "$transcript_path" ]; then
  log "no readable transcript_path"
  exit 0
fi

# Common agent hosts write JSONL, one message per line. Flatten to plain text and keep
# the TAIL: corrections skew late ("no — always do X"), so the head is the part
# safe to drop. The server caps again; this keeps the request small.
transcript=$(jq -rs '
  map(select(type == "object"))
  | map(
      (.message.role // .role // "?") as $role
      | (.message.content // .content) as $c
      | ($c | if type == "string" then .
              elif type == "array" then (map(select(.type? == "text") | .text) | join("\n"))
              else empty end) as $text
      | select($text != null and ($text | length) > 0)
      | "\($role): \($text)"
    )
  | join("\n")
' "$transcript_path" 2>/dev/null | tail -c 200000) || { log "transcript parse failed"; exit 0; }

[ -n "$transcript" ] || { log "empty transcript"; exit 0; }

body=$(jq -n --arg t "$transcript" '{transcript: $t}' 2>/dev/null) || exit 0

# No --fail: it discards the response body, and on 4xx/5xx the body IS the
# answer (the error envelope naming what to fix). The status code rides on the
# last line instead, so a failure logs something actionable rather than
# "request failed".
response=$(curl -s -m 60 -X POST \
  "${WIKIKIT_URL}/v1/spaces/${WIKIKIT_SPACE}/agent/sessions" \
  -H "Authorization: Bearer ${WIKIKIT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  -w '\n%{http_code}' 2>/dev/null) || { log "capture request failed (WikiKit unreachable?)"; exit 0; }

http_code=${response##*$'\n'}
payload=${response%$'\n'*}

if [ "$http_code" = "200" ]; then
  log "$(printf '%s' "$payload" | jq -c '{status, learnings, ingest_id}' 2>/dev/null || printf '%s' "$payload")"
else
  log "http ${http_code}: $(printf '%s' "$payload" | jq -c '{code, error}' 2>/dev/null || printf '%s' "$payload")"
fi
exit 0
