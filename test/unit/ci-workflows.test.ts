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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  test('runs the full gate: lint, typecheck, unit+contract, integration, binary', () => {
    expect(Object.keys(ci.jobs).sort()).toEqual(['binary', 'integration', 'lint', 'test', 'typecheck'])
    expect(runs(job(ci, 'lint'))).toContain('bun run lint')
    expect(runs(job(ci, 'typecheck'))).toContain('bun run typecheck')
    expect(runs(job(ci, 'test'))).toContain('bun test test/unit test/contract')
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
    expect(service.image).toBe('postgres:16-alpine')

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

  test('integration tests are explicitly opted in via RUN_INTEGRATION=1', () => {
    const step = (job(ci, 'integration').steps ?? []).find((s) => s.run === 'bun run test:integration')
    expect(step?.env?.RUN_INTEGRATION).toBe('1')
  })

  test('binary job gates on all checks, builds, and sanity-runs --version', () => {
    expect(job(ci, 'binary').needs?.sort()).toEqual(['integration', 'lint', 'test', 'typecheck'])
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
