// Drift tests for the CI/release pipelines (.github/workflows/, plan §14 +
// §11). The workflows encode couplings that nothing enforces at runtime and
// that fail long after the offending commit if they drift:
//
// - The integration job's service container must mirror the zero-config
//   Postgres contract in scripts/start-local.ts (container NAME, port,
//   credentials) — ensureLocalPostgres() docker-inspects that exact name and
//   would race the service container on the port if it ever diverged.
// - Release asset names and the version-tag regex are consumed by
//   the pull-based deployer (gh release download -p
//   wikikit-linux-x64, tag poll ^v?[0-9]+\.[0-9]+\.[0-9]+$).
//
// Parsing the YAML here turns "the deploy broke three weeks later" into a red
// unit test on the PR that caused it.
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'yaml'
import { LOCAL_CONTAINER, LOCAL_DATABASE_URL } from '../../scripts/start-local.ts'

const root = join(import.meta.dir, '..', '..')

interface Step {
  uses?: string
  run?: string
  env?: Record<string, unknown>
  with?: Record<string, unknown>
  name?: string
}
interface Job {
  'runs-on'?: string
  needs?: string[]
  steps?: Step[]
  services?: Record<
    string,
    { image: string; env?: Record<string, string>; ports?: (string | number)[]; options?: string }
  >
  strategy?: { matrix?: { include?: { os: string; asset: string }[] } }
}
interface Workflow {
  on: Record<string, unknown>
  jobs: Record<string, Job>
}

function load(relative: string): Workflow {
  return parse(readFileSync(join(root, relative), 'utf8')) as Workflow
}

const ci = load('.github/workflows/ci.yml')
const release = load('.github/workflows/release.yml')

// tsconfig has noUncheckedIndexedAccess — a throwing accessor keeps the
// assertions readable while making "job was renamed/removed" a loud failure.
function job(workflow: Workflow, name: string): Job {
  const found = workflow.jobs[name]
  if (!found) throw new Error(`expected job '${name}' to exist`)
  return found
}

function runs(job: Job): string[] {
  return (job.steps ?? []).map((step) => step.run ?? '')
}

describe('ci.yml', () => {
  test('triggers on push to main and on pull requests', () => {
    expect((ci.on.push as { branches: string[] }).branches).toEqual(['main'])
    expect('pull_request' in ci.on).toBe(true)
  })

  test('runs the full gate: lint, typecheck, cockpit, unit+contract, integration, e2e, binary', () => {
    expect(Object.keys(ci.jobs).sort()).toEqual([
      'binary',
      'cockpit',
      'e2e',
      'integration',
      'konvention',
      'lint',
      'test',
      'typecheck',
    ])
    expect(runs(job(ci, 'lint'))).toContain('bun run lint')
    expect(runs(job(ci, 'typecheck'))).toContain('bun run typecheck')
    expect(runs(job(ci, 'cockpit'))).toContain('bun run check:cockpit-drift')
    expect(runs(job(ci, 'test'))).toContain('bun test test/unit test/contract')
    expect(runs(job(ci, 'e2e'))).toContain('bun run test:e2e')
  })

  // CI and the local gate must run the SAME stages, or the hook stops meaning
  // "CI will pass" and people go back to finding out on the PR.
  test('CI jobs and the local gate stages are the same list', () => {
    const gate = readFileSync(new URL('../../scripts/gate.ts', import.meta.url), 'utf8')
    const stageIds = [...gate.matchAll(/\bid: '([a-z0-9-]+)'/g)].map((match) => match[1]!)
    expect(stageIds.sort()).toEqual(['cockpit', 'e2e', 'integration', 'konvention', 'lint', 'typecheck', 'unit'])
    // `test` is CI's name for the gate's `unit` stage; `binary` is CI-only
    // (compiling per-platform artifacts is not something a push should pay for).
    const ciJobs = Object.keys(ci.jobs).filter((name) => name !== 'binary')
    expect(ciJobs.map((name) => (name === 'test' ? 'unit' : name)).sort()).toEqual(stageIds.sort())
  })

  // Every `bun run <name>` in a workflow must resolve, in every workflow.
  // This exists because it happened: a package.json edit was reverted, the
  // `test:e2e` script vanished, and CI failed with "Script not found" — while
  // the local gate passed, because the pre-push hook invokes
  // `bun run scripts/gate.ts` (a file path) and never touches the script names
  // CI depends on. Nothing else covers the seam between the two.
  test('every `bun run <script>` a workflow invokes exists in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const [file, workflow] of [
      ['ci.yml', ci],
      ['release.yml', release],
    ] as const) {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        for (const command of runs(job)) {
          for (const match of command.matchAll(/\bbun run ([a-z][a-z0-9:-]*)/g)) {
            const script = match[1]!
            expect(
              pkg.scripts[script],
              `${file} job '${jobName}' runs \`bun run ${script}\`, which package.json lacks`,
            ).toBeDefined()
          }
        }
      }
    }
  })

  test('every job installs with a frozen lockfile via setup-bun', () => {
    for (const [name, job] of Object.entries(ci.jobs)) {
      const uses = (job.steps ?? []).map((step) => step.uses ?? '')
      expect(
        uses.some((u) => u.startsWith('oven-sh/setup-bun@')),
        `${name} uses setup-bun`,
      ).toBe(true)
      expect(runs(job), `${name} installs frozen`).toContain('bun install --frozen-lockfile')
    }
  })

  test('integration service container mirrors the scripts/start-local.ts contract', () => {
    const service = job(ci, 'integration').services?.postgres
    if (!service) throw new Error('integration job must define a postgres service')
    expect(service.image).toBe('pgvector/pgvector:pg18')

    // The suites connect to LOCAL_DATABASE_URL verbatim — derive every
    // expectation from it instead of repeating literals that could drift too.
    const url = new URL(LOCAL_DATABASE_URL)
    expect(service.env?.POSTGRES_PASSWORD).toBe(url.password)
    expect(service.env?.POSTGRES_DB).toBe(url.pathname.slice(1))
    expect((service.ports ?? []).map(String)).toContain(`${url.port}:5432`)
    // ensureLocalPostgres() inspects this exact container name; without it the
    // helper would `docker run` a second Postgres onto the occupied port.
    expect(service.options ?? '').toContain(`--name ${LOCAL_CONTAINER}`)
  })

  /*
    A BROWSER IS NOT SOMETHING `bun install` BRINGS ALONG. playwright ships no
    install script (`bun pm untrusted` reports 0 packages with scripts), so the
    download step is the only thing that puts Chromium on a runner — while a dev
    machine has one in ~/Library/Caches/ms-playwright and passes either way.
    test/integration/kennung-am-browser.test.ts sat in that gap: green locally,
    red on the first push, and nobody would have learned it from the gate
    (BEFUND-GATE-IST-NICHT-CI — a check that exists and that nobody runs).

    Derived and not listed, so the requirement travels with the suite: each job's
    commands are resolved through package.json, the paths they name are read, and
    every file REACHABLE FROM THEM by relative import is searched for a browser
    dependency. Any job that reaches one must carry the install step.

    WHY THE IMPORT CHAIN AND NOT ONE DIRECTORY. The first version of this test
    read only the named directories, only `.ts`, only `from 'playwright'` in
    single quotes. Measured, one planted Playwright suite each in test/e2e (a job
    with no install step), 14 pass / 0 fail instead of red every time: an import
    through test/helpers/, `await import('playwright')`, and `playwright-core`
    (LOCAL-WI-CI-BROWSERABLEITUNG-BLIND). The first of those is not hypothetical
    — it is the shape of WatchKit's `openHarness()`, the family pattern proposed
    for adoption this round, which bundles the browser entry into a helper file.
    A check and a build style that contradict each other is the check's problem:
    this one moved.
  */

  /**
   * A module specifier in any spelling TypeScript allows — static `from`,
   * side-effect `import`, dynamic `import()`, `require()`. Anything else is a
   * mention, not a dependency.
   */
  const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g

  /**
   * Comments come off first, because a mention is not a dependency. Measured:
   * without this the scan puts THIS file on the list — it discusses
   * `import('playwright')` in the prose above — and demands a browser for the
   * `test` job, 13 pass / 1 fail. The strip is crude (it would also cut at a
   * `//` inside a string), which is safe here for one measured reason: with it
   * in place the scan still finds both real users, and the last assert of the
   * test is what says so.
   */
  const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  /** The packages that put a browser on the machine. `-core` ships the API without one. */
  const BROWSER_PACKAGES = new Set(['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core'])

  /** Relative specifiers are written with their extension here, but resolve both ways. */
  function resolveRelative(fromFile: string, specifier: string): string | undefined {
    const base = join(fromFile, '..', specifier)
    for (const candidate of [base, `${base}.ts`, `${base}.mjs`, join(base, 'index.ts')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    return undefined
  }

  /**
   * The first browser dependency reachable from `entry`, as "file -> package",
   * or undefined. Depth-first over relative imports, so a helper two files away
   * is found — that is the whole point.
   */
  function browserDependency(entry: string, seen = new Set<string>()): string | undefined {
    if (seen.has(entry)) return undefined
    seen.add(entry)
    const source = withoutComments(readFileSync(entry, 'utf8'))
    const specifiers = [...source.matchAll(SPECIFIER)].map((match) => match[1]!)
    const direct = specifiers.find((specifier) => BROWSER_PACKAGES.has(specifier))
    if (direct) return `${relative(root, entry)} -> ${direct}`
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue
      const next = resolveRelative(entry, specifier)
      if (!next) continue
      const found = browserDependency(next, seen)
      if (found) return found
    }
    return undefined
  }

  /** Every file a `bun test test/x scripts/y.ts` style command puts in play. */
  function entryFiles(command: string): string[] {
    const named = [...command.matchAll(/\b(?:test|scripts)\/[A-Za-z0-9._/-]+/g)].map((match) => join(root, match[0]))
    return named.flatMap((path) => {
      if (!existsSync(path)) return []
      if (statSync(path).isFile()) return [path]
      return readdirSync(path, { recursive: true })
        .map((file) => join(path, String(file)))
        .filter((file) => statSync(file).isFile() && /\.(ts|mjs|js)$/.test(file))
    })
  }

  test('every job whose suites drive a browser installs one', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const resolve = (command: string) =>
      command.replace(/\bbun run ([a-z][a-z0-9:-]*)/g, (whole, script: string) => pkg.scripts[script] ?? whole)

    let scanned = 0
    for (const [name, entry] of Object.entries(ci.jobs)) {
      const commands = runs(entry).map(resolve)
      const users = [...new Set(commands.flatMap(entryFiles))]
        .map((file) => browserDependency(file))
        .filter((found): found is string => found !== undefined)
      if (users.length === 0) continue
      scanned += 1
      const install = commands.find((command) => /\bplaywright install\b.*\bchromium\b/.test(command))
      expect(install, `job '${name}' reaches ${[...new Set(users)].join(', ')} but installs no browser`).toBeDefined()
      // A bare ubuntu-latest does not ship Chromium's system libraries.
      expect(install ?? '', `job '${name}' installs a browser without its system libraries`).toContain('--with-deps')
    }

    // Both browser-driving jobs must be SEEN, not merely not-failed: a suite
    // renamed out of reach, or an import chain this walk cannot follow, would
    // otherwise read as a pass. `integration` reaches it through a suite,
    // `konvention` through scripts/konvention-check.mjs — a dynamic import in a
    // .mjs file, which the previous version of this scan could not see at all.
    expect(scanned, 'a job stopped being seen, or a new one appeared — change this number deliberately').toBe(2)
  })

  test('integration tests are explicitly opted in via RUN_INTEGRATION=1', () => {
    const step = (job(ci, 'integration').steps ?? []).find((s) => s.run === 'bun run test:integration')
    expect(step?.env?.RUN_INTEGRATION).toBe('1')
  })

  test('e2e tests are explicitly opted in via RUN_INTEGRATION=1', () => {
    const step = (job(ci, 'e2e').steps ?? []).find((s) => s.run === 'bun run test:e2e')
    expect(step?.env?.RUN_INTEGRATION).toBe('1')
  })

  test('binary job gates on all checks, builds, and sanity-runs --version', () => {
    expect(job(ci, 'binary').needs?.sort()).toEqual(['e2e', 'integration', 'lint', 'test', 'typecheck'])
    expect(runs(job(ci, 'binary'))).toContain('bash build-binary.sh')
    expect(runs(job(ci, 'binary'))).toContain('./dist/wikikit --version')
  })
})

describe('release.yml', () => {
  test('triggers on v* tags and guards with the deploy pipeline version regex', () => {
    expect((release.on.push as { tags: string[] }).tags).toEqual(['v*'])
    const guard = runs(job(release, 'verify-tag')).join('\n')
    // The deployer polls releases matching exactly this pattern; the guard
    // must also pin the tag to package.json so /ready can match the tag.
    expect(guard).toContain('^v?[0-9]+\\.[0-9]+\\.[0-9]+$')
    expect(guard).toContain('jq -r .version package.json')
    expect(job(release, 'build').needs).toContain('verify-tag')
  })

  test('builds the deploy-contract assets natively per OS', () => {
    const include = job(release, 'build').strategy?.matrix?.include ?? []
    const assets = include.map((entry) => entry.asset)
    // wikikit-linux-x64 is what the deploy pipeline downloads; macos-arm64 is
    // the dev machine target. linux-arm64 is optional but ships.
    expect(assets).toContain('wikikit-linux-x64')
    expect(assets).toContain('wikikit-macos-arm64')
    for (const entry of include) expect(entry.asset.startsWith('wikikit-')).toBe(true)

    const build = job(release, 'build').steps ?? []
    const buildStep = build.find((step) => step.run === 'bash build-binary.sh')
    expect(buildStep?.env?.OUTFILE).toBe('dist/${{ matrix.asset }}')
    const upload = build.find((step) => (step.uses ?? '').startsWith('actions/upload-artifact@'))
    expect(upload?.with?.['if-no-files-found']).toBe('error')
  })

  test('publishes SHA256SUMS and fails on missing assets', () => {
    const steps = job(release, 'release').steps ?? []
    expect(job(release, 'release').needs).toContain('build')
    expect(runs(job(release, 'release')).join('\n')).toContain('sha256sum wikikit-* > SHA256SUMS')
    const gh = steps.find((step) => (step.uses ?? '').startsWith('softprops/action-gh-release@'))
    expect(gh?.with?.fail_on_unmatched_files).toBe(true)
  })
})

describe('dependabot.yml', () => {
  test('updates the bun ecosystem (not npm — only bun.lock exists) and actions', () => {
    const config = parse(readFileSync(join(root, '.github/dependabot.yml'), 'utf8')) as {
      updates: { 'package-ecosystem': string; schedule: { interval: string } }[]
    }
    const ecosystems = config.updates.map((update) => update['package-ecosystem']).sort()
    expect(ecosystems).toEqual(['bun', 'github-actions'])
    for (const update of config.updates) expect(update.schedule.interval).toBe('weekly')
  })
})
