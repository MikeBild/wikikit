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

# Status code only.
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
# Body only, failures swallowed so a refusal is data rather than a crash.
body() { curl -sS "$@" 2>/dev/null || true; }
# Headers only, lower-cased so a proxy's capitalisation is not a test result.
head_of() { curl -sSI "$@" 2>/dev/null | tr '[:upper:]' '[:lower:]' || true; }

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
case "$BASE" in
  http://127.0.0.1* | http://localhost* | 'http://[::1]'*)
    skip "/metrics gating (no reverse proxy in front of a loopback address)"
    ;;
  *)
    METRICS="$(code "$BASE/metrics")"
    case "$METRICS" in
      200) fail "/metrics is not reachable from outside" "answered 200 — the reverse proxy is not gating it" ;;
      *) pass "/metrics is not reachable from outside (${METRICS})" ;;
    esac
    ;;
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
case "$COCKPIT_HEAD" in
  *"script-src 'self' 'sha256-"*) pass "the CSP admits the inline theme script by hash" ;;
  *) fail "the CSP admits the inline theme script by hash" "script-src is not hash-based — check src/cockpit.ts" ;;
esac
# Two steps, deliberately. "no unsafe-inline in script-src" is a statement
# about a policy, and a deployment serving NO policy would satisfy it by
# absence — which is the worst possible false green, since it is precisely the
# deployment where injected markup runs.
case "$COCKPIT_HEAD" in
  *"content-security-policy:"*)
    case "$COCKPIT_HEAD" in
      *"script-src 'self' 'unsafe-inline'"* | *"script-src 'unsafe-inline'"*)
        fail "the CSP carries no script unsafe-inline" "unsafe-inline is the directive that lets injected markup run"
        ;;
      *) pass "the CSP carries no script unsafe-inline" ;;
    esac
    ;;
  *) fail "the CSP carries no script unsafe-inline" "there is no content-security-policy header at all" ;;
esac
# A client-side route is not a file: it must fall back to the shell, or every
# link an operator shares 404s on reload.
expect_code "a deep cockpit route falls back to the shell" 200 "$BASE/cockpit/changes"

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
