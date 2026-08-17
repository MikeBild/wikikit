#!/usr/bin/env bash
# Post-deploy smoke test — the checks a release must pass on the installation
# it just landed on.
#
#   WIKIKIT_DEPLOY_URL=https://knowledge.example ./scripts/deploy/smoke.sh
#   WIKIKIT_DEPLOY_URL=... EXPECT_VERSION=0.22.0 ./scripts/deploy/smoke.sh
#
# WHY the URL comes from the environment and never from this file: WikiKit
# knows nothing about where it runs. A release is a published artifact, not a
# deployment trigger, and the deployer is outside this repository — so a
# hostname committed here would be both wrong for every other installation and
# a fact about somebody's infrastructure sitting in a public repo.
#
# Read-only by construction. Every request below is a GET or an unauthenticated
# probe: this runs against a live installation, possibly one the person running
# it does not own, and a smoke test that creates anything is a smoke test nobody
# dares run when it matters.
set -euo pipefail

BASE="${WIKIKIT_DEPLOY_URL:-}"
if [ -z "$BASE" ]; then
  echo "✗ WIKIKIT_DEPLOY_URL is not set — this script has no default and will not guess one." >&2
  exit 2
fi
BASE="${BASE%/}"

PASS=0
FAIL=0
SKIP=0

pass() {
  PASS=$((PASS + 1))
  printf '  \033[32m✓\033[0m %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf '  \033[31m✗\033[0m %s\n' "$1"
  [ $# -gt 1 ] && printf '      %s\n' "$2"
}
# A check this run genuinely cannot make. Counted and printed rather than
# quietly omitted: a run that silently does less than the reader thinks grants
# confidence it did not earn.
skip() {
  SKIP=$((SKIP + 1))
  printf '  \033[33m–\033[0m skipped: %s\n' "$1"
}

# WHEN this script runs: seconds after the deployer moved a new binary into
# place and restarted the unit. A connection refused or reset in that window is
# the service still coming up, not a broken release — but nothing here can tell
# the two apart from a single attempt, and every check reads a refusal as a
# fact about the deployment. So a connection-level failure is retried before it
# is believed.
#
# `--retry-connrefused` because a refusal is the exact shape a not-yet-listening
# socket has. `--connect-timeout` separately from `--max-time` so a black-holed
# packet gives up in seconds while a genuinely slow page still gets its time.
# HTTP responses are not retried by this: curl retries 5xx as well, and no check
# below expects one, so the only effect there would be to arrive at the same
# answer more slowly.
#
# This is not only about production. Run against a loopback server under load —
# which is what the test suite does — an occasional refusal made the whole gate
# non-deterministic, and a gate people re-run instead of read has stopped being
# a gate.
# How long to keep believing the service is still coming up. Tunable because
# the right answer belongs to whoever runs the deployer, not to this file: a
# unit that restarts in a second wants none of this, and one that reconnects a
# pool first may want more.
CURL_RETRY=(--retry "${SMOKE_CONNECT_RETRIES:-2}" --retry-delay 1 --retry-connrefused --connect-timeout 5 --max-time 30)

# Status code only. `000` is curl's "no HTTP response at all" — a caller that
# compares against a real status must treat it as absence, never as a value.
#
# The failure is swallowed, like `body`'s, so an unreachable installation is
# DATA rather than a crash. Without this, `set -e` killed the script inside the
# first command substitution and printed one raw curl line: a run that promises
# a named list of checks would end having reported none of them, on precisely
# the deployment somebody most needs the list for. Now every check gets asked
# and every one of them says `got 000`.
code() { curl -sS "${CURL_RETRY[@]}" -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true; }
# Body only, failures swallowed so a refusal is data rather than a crash. Every
# caller judges the body's CONTENT, so an empty string fails whatever it was
# asked — no check below is satisfied by a body's silence.
body() { curl -sS "${CURL_RETRY[@]}" "$@" 2>/dev/null || true; }
# Headers only, lower-cased so a proxy's capitalisation is not a test result,
# and de-CRed so a header value never carries a stray \r into a comparison or
# into the diagnostic printed next to a failure.
head_of() { curl -sSI "${CURL_RETRY[@]}" "$@" 2>/dev/null | tr -d '\r' | tr '[:upper:]' '[:lower:]' || true; }

# The directive of a Content-Security-Policy that actually governs <script>:
# `script-src` when the policy names one, `default-src` when it does not,
# because that is the fallback the browser applies. Prints the whole directive
# ("script-src 'self' 'sha256-…'") or nothing at all.
#
# WHY this parses instead of globbing the raw header for two adjacent tokens,
# which is what it used to do: `cockpitCsp` builds the directive as
# "script-src 'self'" followed by one hash per inline block, so the regression
# this check exists to catch — a source getting APPENDED — produces
# `script-src 'self' 'sha256-…' 'unsafe-inline'`. That string contains neither
# "script-src 'self' 'unsafe-inline'" nor "script-src 'unsafe-inline'", so an
# adjacency glob prints a green tick over precisely the deployment where
# injected markup runs. Splitting on ';' and judging the whole directive cannot
# be fooled by where in it a source appears.
#
# awk rather than a shell loop: the policy is one line of ';'-separated
# directives with significant leading spaces, and awk splits and trims it in
# four lines where the pure-shell version needs a nested peel-and-trim loop.
# awk is POSIX and is already as certain to be present as curl and sed.
script_directive() {
  printf '%s\n' "$1" | awk '
    /^content-security-policy:/ {
      policy = $0
      sub(/^content-security-policy:[ \t]*/, "", policy)
      count = split(policy, directives, ";")
      for (i = 1; i <= count; i++) {
        directive = directives[i]
        gsub(/^[ \t]+|[ \t]+$/, "", directive)
        if (directive ~ /^script-src([ \t]|$)/) script = directive
        else if (directive ~ /^default-src([ \t]|$)/) fallback = directive
      }
    }
    END { print (script != "" ? script : fallback) }
  '
}

expect_code() {
  local label="$1" want="$2" got
  shift 2
  got="$(code "$@")"
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label" "expected $want, got $got"; fi
}

echo "› smoking ${BASE}"

echo "· the service answers"
expect_code "/health is 200" 200 "$BASE/health"
expect_code "/ready is 200" 200 "$BASE/ready"
expect_code "/openapi.json is 200" 200 "$BASE/openapi.json"
expect_code "/llms.txt is 200" 200 "$BASE/llms.txt"
expect_code "the service descriptor is 200" 200 "$BASE/.well-known/service-descriptor.json"

READY="$(body "$BASE/ready")"
SERVED="$(printf '%s' "$READY" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [ -n "$SERVED" ]; then
  pass "/ready names its version (${SERVED})"
else
  fail "/ready names its version" "no version field in: ${READY}"
fi
if [ -n "${EXPECT_VERSION:-}" ]; then
  if [ "$SERVED" = "$EXPECT_VERSION" ]; then
    pass "the served version is the released one"
  else
    # The deploy is pull-based: a mismatch means the deployer has not rolled
    # forward yet, which is a legitimate in-between state — but it is not a
    # verified release, and this must not report one.
    fail "the served version is the released one" "expected ${EXPECT_VERSION}, serving ${SERVED}"
  fi
fi

echo "· the knowledge surface is closed to strangers"
expect_code "/v1/spaces refuses without a credential" 401 "$BASE/v1/spaces"
MCP_HEAD="$(head_of "$BASE/mcp")"
case "$MCP_HEAD" in
  *www-authenticate*) pass "/mcp advertises how to authenticate" ;;
  *) fail "/mcp advertises how to authenticate" "no www-authenticate header in the /mcp response" ;;
esac
# /metrics is unauthenticated by design and must be proxy-gated, so from the
# outside it has to be refused. A 200 here is an open metrics endpoint.
#
# Except against a loopback address, where there is no proxy in the picture at
# all: the service binds 127.0.0.1 and the gate lives in front of it. Reporting
# a pass there would be the check claiming to have verified something it never
# saw, and reporting a failure would train people to ignore a red line.
#
# SMOKE_PROXIED=1 forces the judged branch for an address that looks like
# loopback. It exists so this branch can be held against installations that are
# wrong on purpose — it is the only check here that a loopback fixture could
# not otherwise reach, and an unreachable check is an unproven one.
LOOPBACK=no
case "$BASE" in
  http://127.0.0.1* | http://localhost* | 'http://[::1]'*) LOOPBACK=yes ;;
esac
[ "${SMOKE_PROXIED:-}" = '1' ] && LOOPBACK=no
if [ "$LOOPBACK" = yes ]; then
  METRICS=loopback
else
  METRICS="$(code "$BASE/metrics")"
fi
case "$METRICS" in
  loopback)
    skip "/metrics gating (no reverse proxy in front of a loopback address)"
    ;;
  200) fail "/metrics is not reachable from outside" "answered 200 — the reverse proxy is not gating it" ;;
  # No HTTP response at all, after retries. This is NOT evidence of gating, and
  # calling it one would be the worst reading available: `000` is equally what a
  # firewall dropping the packet looks like and what a broken network looks
  # like, and only the first of those is the deployment being correct. Nothing
  # here can tell them apart, so this run did not make the check.
  000)
    skip "/metrics gating (no HTTP response — a dropped packet and a network fault look identical from here)"
    ;;
  *) pass "/metrics is not reachable from outside (${METRICS})" ;;
esac

echo "· the cockpit is served"
expect_code "/cockpit/ is 200" 200 "$BASE/cockpit/"
COCKPIT_HEAD="$(head_of "$BASE/cockpit/")"
case "$COCKPIT_HEAD" in
  *"content-type: text/html"*) pass "/cockpit/ serves the shell" ;;
  *) fail "/cockpit/ serves the shell" "unexpected content-type" ;;
esac
case "$COCKPIT_HEAD" in
  *"cache-control: no-cache"*) pass "the shell is never cached" ;;
  *) fail "the shell is never cached" "index.html is the only file naming the current bundle" ;;
esac
CSP_SCRIPT="$(script_directive "$COCKPIT_HEAD")"
case "$CSP_SCRIPT" in
  "script-src 'self'"*"'sha256-"*) pass "the CSP admits the inline theme script by hash" ;;
  *) fail "the CSP admits the inline theme script by hash" "script-src is not hash-based — check src/cockpit.ts (${CSP_SCRIPT:-no script-src})" ;;
esac
# Three outcomes, deliberately. "no unsafe-inline in script-src" is a statement
# about a policy, and a deployment serving NO policy would satisfy it by
# absence — which is the worst possible false green, since it is precisely the
# deployment where injected markup runs. A policy naming neither script-src nor
# default-src is the same hole wearing a header: nothing constrains a <script>
# there either, and `script_directive` returns nothing for it rather than
# something reassuringly free of the word unsafe-inline.
case "$COCKPIT_HEAD" in
  *"content-security-policy:"*)
    case "$CSP_SCRIPT" in
      '')
        fail "the CSP carries no script unsafe-inline" "the policy constrains scripts with neither script-src nor default-src"
        ;;
      *"'unsafe-inline'"*)
        fail "the CSP carries no script unsafe-inline" "unsafe-inline lets injected markup run (${CSP_SCRIPT})"
        ;;
      *) pass "the CSP carries no script unsafe-inline" ;;
    esac
    ;;
  *) fail "the CSP carries no script unsafe-inline" "there is no content-security-policy header at all" ;;
esac
# A client-side route is not a file: it must fall back to the shell, or every
# link an operator shares 404s on reload.
expect_code "a deep cockpit route falls back to the shell" 200 "$BASE/cockpit/decisions"

COCKPIT_HTML="$(body "$BASE/cockpit/")"
case "$COCKPIT_HTML" in
  *'name="cockpit-ui-digest" content="sha256-'*) pass "the shell announces its design-token digest" ;;
  *) fail "the shell announces its design-token digest" "CUI-MARK-1 — the marker is derived at build time" ;;
esac

echo "· the sign-in funnel"
SESSION="$(body -H 'accept: application/json' "$BASE/v1/session")"
case "$SESSION" in
  *'"session":null'* | *'"session": null'*) pass "/v1/session answers null for an anonymous tab" ;;
  *) fail "/v1/session answers null for an anonymous tab" "got: ${SESSION}" ;;
esac
expect_code "/v1/session never 401s" 200 -H 'accept: application/json' "$BASE/v1/session"
expect_code "cockpit-login redirects into the chooser" 302 "$BASE/v1/identity/cockpit-login?return_to=%2Fcockpit%2F"

# Follow the redirect and read the page a human would actually see. It has to
# be the CHOOSER specifically — a page offering a way in — not merely a page
# with the words "Sign in" on it.
CHOOSER="$(body -L "$BASE/v1/identity/cockpit-login?return_to=%2Fcockpit%2F")"
case "$CHOOSER" in
  *'class="provider-stack"'*) pass "the chooser renders" ;;
  *) fail "the chooser renders" "no provider chooser behind the redirect" ;;
esac
# Step one offers a CHOICE of method and must not ask for a credential: a key
# field on the first screen is how an operator learns to paste a key before
# noticing SSO exists. Guarded on the chooser existing, or a 404 would satisfy
# "no credential field" by having no fields at all.
case "$CHOOSER" in
  *'class="provider-stack"'*)
    case "$CHOOSER" in
      *'name="api_key"'*) fail "step one asks for no credential" "an api_key field is on the provider chooser" ;;
      *) pass "step one asks for no credential" ;;
    esac
    ;;
  *) fail "step one asks for no credential" "there is no chooser to inspect" ;;
esac

echo
SKIP_NOTE=''
[ "$SKIP" -gt 0 ] && SKIP_NOTE=" ($SKIP skipped)"
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m✓ %d checks passed%s\033[0m\n' "$PASS" "$SKIP_NOTE"
else
  printf '\033[31m✗ %d of %d checks failed%s\033[0m\n' "$FAIL" "$((PASS + FAIL))" "$SKIP_NOTE"
  exit 1
fi
