// Point git at the committed hooks — `bun run hooks:install`.
//
// WHY core.hooksPath instead of copying files into .git/hooks: a copy is a
// snapshot that silently rots the moment the committed hook changes, and
// nobody re-runs an installer they ran once. Pointing git at the tracked
// directory means the hook you get is always the hook in the repo.
//
// WHY this is not automatic (no postinstall): `bun install` running a script
// that rewires git is a surprise, and a repo that installs hooks behind your
// back is a repo people stop trusting. It is one command, documented in
// CONTRIBUTING.md.
import { spawnSync } from 'node:child_process'
import { chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const hooksDir = join(root, '.githooks')

// Executability does not survive every checkout path (zip downloads, some
// Windows clones), and a non-executable hook fails silently — git just does
// not run it, which is the worst possible failure for a safety net.
for (const name of readdirSync(hooksDir)) {
  chmodSync(join(hooksDir, name), 0o755)
}

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)

console.log('git hooks installed (core.hooksPath = .githooks)')
console.log('  pre-push → bun run gate: lint, typecheck, unit + contract, integration, e2e')
console.log('  bypass:  SKIP=integration,e2e git push   |   git push --no-verify')
