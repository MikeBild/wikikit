// The gate — every check that must pass before code leaves this machine.
// `bun run gate`, and automatically on `git push` via .githooks/pre-push.
//
// WHY a script and not a list of steps in the hook: the hook, CI and a human
// typing `bun run gate` must run the SAME checks. Three copies of a checklist
// drift, and the one that drifts is always the local one — so this file is the
// single definition and the others call it.
//
// Design rules, learned the hard way:
//   - NEVER skip silently. A gate that quietly does less than you think is
//     worse than no gate: it grants confidence it did not earn. Docker missing
//     is reported loudly and (by default) fails.
//   - Fail fast, but keep reading. Stages run in cost order (lint before
//     Postgres) and stop at the first failure — the second error is usually
//     noise from the first.
//   - Have an escape hatch, and make it visible. SKIP=... is honoured and
//     printed, so a deliberate bypass is on the record instead of being
//     laundered through `--no-verify`.
import { spawnSync } from 'node:child_process'
import { ensureLocalPostgres } from './start-local.ts'

interface Stage {
  id: string
  title: string
  command: string[]
  /** Needs the Docker Postgres. */
  database?: boolean
  env?: Record<string, string>
}

const STAGES: Stage[] = [
  // Cheapest first: a formatting failure should not cost you a database spin-up.
  { id: 'lint', title: 'lint + format', command: ['bun', 'run', 'lint'] },
  { id: 'typecheck', title: 'typecheck', command: ['bun', 'run', 'typecheck'] },
  // Includes the drift gates: docs, env templates, OpenAPI snapshot, tool
  // lists, CHANGELOG, prompt budgets. This is the stage that keeps the docs
  // honest, which is why it is not optional.
  {
    id: 'unit',
    title: 'unit + contract (incl. docs/OpenAPI drift)',
    command: ['bun', 'test', 'test/unit', 'test/contract'],
  },
  {
    id: 'integration',
    title: 'integration (real Postgres)',
    command: ['bun', 'test', 'test/integration'],
    database: true,
    env: { RUN_INTEGRATION: '1' },
  },
  {
    id: 'e2e',
    title: 'e2e (real SDK → stub Anthropic endpoint)',
    command: ['bun', 'test', 'test/e2e'],
    database: true,
    env: { RUN_INTEGRATION: '1' },
  },
]

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

// SKIP=integration,e2e — deliberate, and printed in the summary so it cannot
// be a quiet habit.
const skipped = new Set(
  (process.env.SKIP ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
const unknown = [...skipped].filter((id) => !STAGES.some((stage) => stage.id === id))
if (unknown.length) {
  console.error(red(`SKIP names no such stage: ${unknown.join(', ')}`))
  console.error(dim(`stages: ${STAGES.map((s) => s.id).join(', ')}`))
  process.exit(2)
}

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const started = Bun.nanoseconds()
const plan = STAGES.filter((stage) => !skipped.has(stage.id))
const needsDatabase = plan.some((stage) => stage.database)

console.log(bold('\nwikikit gate\n'))

if (needsDatabase) {
  if (!hasDocker()) {
    // The loud failure the design rule calls for: these stages are exactly the
    // ones that catch what unit tests cannot, so "Docker is off" must never
    // quietly downgrade the gate to a subset.
    console.error(red('  ✗ Docker is not running, and integration + e2e need it.\n'))
    console.error('    Start Docker Desktop and re-run, or bypass deliberately:')
    console.error(dim('      SKIP=integration,e2e bun run gate\n'))
    process.exit(1)
  }
  ensureLocalPostgres()
}

for (const stage of plan) {
  process.stdout.write(`  ${stage.title} ${dim('…')}\r`)
  const stageStarted = Bun.nanoseconds()
  const result = spawnSync(stage.command[0]!, stage.command.slice(1), {
    stdio: 'pipe',
    env: { ...process.env, ...stage.env },
    encoding: 'utf8',
  })
  const seconds = ((Bun.nanoseconds() - stageStarted) / 1e9).toFixed(1)

  if (result.status !== 0) {
    console.log(`  ${red('✗')} ${stage.title} ${dim(`(${seconds}s)`)}\n`)
    // The failing stage's own output is the useful part — print it verbatim
    // rather than summarising it away.
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    console.error(red(`\ngate failed at: ${stage.id}\n`))
    process.exit(1)
  }
  console.log(`  ${green('✓')} ${stage.title} ${dim(`(${seconds}s)`)}`)
}

const total = ((Bun.nanoseconds() - started) / 1e9).toFixed(1)
if (skipped.size) {
  console.log(yellow(`\n  ! skipped: ${[...skipped].join(', ')} — these were NOT checked`))
}
console.log(green(`\ngate passed ${dim(`(${total}s)`)}\n`))
