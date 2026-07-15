#!/usr/bin/env bun
// Regenerate the committed OpenAPI snapshot (docs/openapi.json) from the
// ROUTES registry — the same buildOpenApi() call that serves GET /openapi.json
// at runtime, so the snapshot IS the live document at the committed version.
//
// WHY a committed snapshot at all: SubKit's import_connector_from_spec (and
// any other OpenAPI tooling) can consume the contract without booting a
// server, and every HTTP-surface change shows up as a reviewable diff. The
// drift test compares this file against buildOpenApi(ROUTES) so it can never
// silently go stale.
//
//   bun scripts/gen-openapi-doc.ts          # rewrite docs/openapi.json
//   bun scripts/gen-openapi-doc.ts --check  # exit 1 when the snapshot drifted
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'
import { buildOpenApi } from '../src/http/openapi.ts'
import { ROUTES } from '../src/http/routes.ts'
import { VERSION } from '../src/version.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'docs', 'openapi.json')

// Formatted with the repo's resolved prettier config so the committed
// snapshot is byte-stable under BOTH gates: `prettier --check .` (lint) and
// this script's --check.
const prettierConfig = (await resolveConfig(target)) ?? {}
const document = await format(JSON.stringify(buildOpenApi(ROUTES, { version: VERSION })), {
  ...prettierConfig,
  parser: 'json',
})

if (process.argv.includes('--check')) {
  let existing = ''
  try {
    existing = readFileSync(target, 'utf8')
  } catch {
    // missing snapshot counts as drift
  }
  if (existing !== document) {
    console.error('docs/openapi.json is stale — run: bun scripts/gen-openapi-doc.ts')
    process.exit(1)
  }
  console.log('docs/openapi.json is up to date')
} else {
  writeFileSync(target, document)
  console.log(`wrote ${target} (version ${VERSION}, ${ROUTES.length} routes)`)
}
