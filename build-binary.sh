#!/usr/bin/env bash
# Build the self-contained wikikit binary (plan §1: native `bun build
# --compile`, no launcher/unpack step — all dependencies are pure JS).
#
#   ./build-binary.sh            → dist/wikikit
#   OUTFILE=dist/wikikit-linux-x64 ./build-binary.sh   (release matrix naming)
#
# The version is injected at compile time (--define WIKIKIT_BUILD_VERSION):
# the compiled binary has no package.json on disk, and /ready must report the
# exact release version for the deploy health gate. The script verifies the
# produced binary by running `--version` and comparing — a binary that cannot
# identify itself must never ship.
set -euo pipefail
cd "$(dirname "$0")"

OUTFILE="${OUTFILE:-dist/wikikit}"

echo "› regenerating embedded migrations"
bun scripts/gen-embedded-migrations.ts

VERSION="$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)')"
echo "› building ${OUTFILE} (version ${VERSION})"
mkdir -p "$(dirname "$OUTFILE")"
# The NODE_ENV identity define is load-bearing, not decoration.
#
# Without it the bundler replaces the expression `process.env.NODE_ENV` with the
# BUILD machine's value — "development" on a CI runner — as a compile-time
# constant. The shipped binary then never reads the variable, so systemd
# starting it with NODE_ENV=production changes nothing and every production gate
# inverts: the mandatory-configuration check is skipped, .env.defaults is read
# in production (the exact leak the loader's header comment promises cannot
# happen), WIKIKIT_WEBHOOK_ALLOW_PRIVATE falls back to permitting private
# webhook targets, and a `*`-scope bootstrap key is minted and printed in
# plaintext on a first boot with no keys.
#
# Verified against this repository's own binary before the define was added.
# A sibling product shipped the same defect to production twice.
bun build bin/wikikit.ts \
  --compile \
  --define "process.env.NODE_ENV=process.env.NODE_ENV" \
  --define "WIKIKIT_BUILD_VERSION=\"${VERSION}\"" \
  --outfile "$OUTFILE"

echo "› verifying binary self-identifies"
GOT="$("./$OUTFILE" --version)"
if [ "$GOT" != "$VERSION" ]; then
  echo "✗ version mismatch: binary reports '${GOT}', package.json says '${VERSION}'" >&2
  exit 1
fi

# Prove the production branch survives compilation, by running the artifact.
#
# No source-level check can see this: the source is correct either way, and only
# the compiled binary knows whether it still reads the variable. Started with
# NODE_ENV=production and nothing else, a correct binary must refuse to boot and
# name what is missing.
#
# Two details the first attempt got wrong:
#   - run from an EMPTY directory. The loader resolves .env and .env.defaults
#     relative to the working directory, so a developer's local .env would
#     satisfy the very check being exercised.
#   - bound it with a TIMEOUT. A binary that still believes it is in development
#     boots successfully and serves — it never exits, so an unbounded capture
#     hangs the build instead of failing it.
echo "› verifying the production branch survives compilation"
BINARY_ABS="$(cd "$(dirname "$OUTFILE")" && pwd)/$(basename "$OUTFILE")"
PROBE_DIR="$(mktemp -d)"
PROBE_LOG="$PROBE_DIR/out"
(
  cd "$PROBE_DIR" && env -u DATABASE_URL -u WIKIKIT_KEY_PEPPER -u WIKIKIT_OAUTH_PROVIDERS -u WIKIKIT_PUBLIC_URL NODE_ENV=production WIKIKIT_SKIP_DOTENV=1 \
    "$BINARY_ABS" > "$PROBE_LOG" 2>&1
) &
PROBE_PID=$!
# Bounded in pure shell rather than with timeout(1), which macOS does not ship:
# a missing timeout would land in the captured output and read as a failure of
# the binary rather than of the harness.
for _ in $(seq 1 40); do
  kill -0 "$PROBE_PID" 2>/dev/null || break
  sleep 0.5
done
kill -9 "$PROBE_PID" 2>/dev/null || true
wait "$PROBE_PID" 2>/dev/null || true
OUT="$(cat "$PROBE_LOG" 2>/dev/null || true)"
rm -rf "$PROBE_DIR"
case "$OUT" in
  *"missing production configuration"*) ;;
  *)
    echo "✗ the binary did not take the production branch under NODE_ENV=production." >&2
    echo "  Expected a 'missing production configuration' refusal; got:" >&2
    printf '%s\n' "$OUT" | head -5 >&2
    echo "  The NODE_ENV identity define above is what makes this pass." >&2
    exit 1
    ;;
esac

echo "✓ ${OUTFILE} ($(du -h "$OUTFILE" | cut -f1), version ${GOT})"
