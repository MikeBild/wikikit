// Single source of truth for the running version.
//
// WHY two paths: in dev (bun runs TS from the repo) the version is read from
// package.json, so bumping the version never requires touching code. In the
// compiled single binary (`bun build --compile`) there is no package.json on
// disk and import.meta.url points into the virtual bunfs — so build-binary.sh
// injects the version at compile time via
//   bun build --define 'WIKIKIT_BUILD_VERSION="x.y.z"' ...
// The typeof-guard makes the injected constant optional: undefined identifier
// checks via `typeof` never throw at runtime.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const WIKIKIT_BUILD_VERSION: string | undefined

function readPackageVersion(): string {
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)))
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
  } catch {
    // Compiled binary without --define, or exotic runtime layout. A visible
    // sentinel beats a crash: /ready compares versions during deploys, and
    // '0.0.0-unknown' fails that gate loudly instead of silently passing.
  }
  return '0.0.0-unknown'
}

export const VERSION: string =
  typeof WIKIKIT_BUILD_VERSION === 'string' && WIKIKIT_BUILD_VERSION.length > 0
    ? WIKIKIT_BUILD_VERSION
    : readPackageVersion()
