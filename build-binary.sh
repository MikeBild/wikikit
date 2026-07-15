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
bun build bin/wikikit.ts \
  --compile \
  --define "WIKIKIT_BUILD_VERSION=\"${VERSION}\"" \
  --outfile "$OUTFILE"

echo "› verifying binary self-identifies"
GOT="$("./$OUTFILE" --version)"
if [ "$GOT" != "$VERSION" ]; then
  echo "✗ version mismatch: binary reports '${GOT}', package.json says '${VERSION}'" >&2
  exit 1
fi

echo "✓ ${OUTFILE} ($(du -h "$OUTFILE" | cut -f1), version ${GOT})"
