// Drift guards — the checks that keep the shipped artifacts describing the
// implementation: the router, the OpenAPI document, the env surface, the MCP
// palette, the prompts, and the hand-written docs agents and operators read.
// Removing a route, adding an env var without documenting it, renaming a tool,
// or cutting a release with no CHANGELOG entry must turn CI red, never ship.
//
// WHY source and docs are parsed with regexes instead of importing richer
// metadata: the docs are hand-maintained prose (llms.txt/llms-full.txt are the
// product's self-description for agents) and config.ts reads process.env
// imperatively. Parsing the artifacts that actually ship is the whole point —
// a drift test that reads a helper export would only prove the helper agrees
// with itself.
//
// This file is deliberately the ONLY drift suite. It used to be two
// (drift.test.ts + docs-drift.test.ts) that checked overlapping things with
// different regexes, and that split cost real accuracy: the stricter of two
// env-var scanners forced a test-harness-only variable into the operator
// documentation, because "some drift test wants it" is indistinguishable from
// "operators need it" when there are two. One list, one place to look.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LLM_PROVIDER_KEY_ENV, loadConfig } from '../../src/config.ts'
import { buildOpenApi } from '../../src/http/openapi.ts'
import { HANDLERS, ROUTES } from '../../src/http/routes.ts'
import { PROMPT_VERSIONS } from '../../src/llm/prompts/index.ts'
import { TOOLS } from '../../src/mcp/tools.ts'
import { VERSION } from '../../src/version.ts'

const root = join(import.meta.dir, '..', '..')

const read = (rel: string): string => {
  try {
    return readFileSync(join(root, rel), 'utf8')
  } catch {
    throw new Error(`${rel} is missing — it is a committed release artifact`)
  }
}

const routePaths = (): Set<string> => new Set(ROUTES.map((route) => route.path))

// Set-equality with a message that names the drift in both directions —
// "only in first/second" beats a wall of sorted arrays when 31 routes diverge
// by one entry.
function eqSets(a: Set<string>, b: Set<string>, label: string): void {
  const onlyA = [...a].filter((entry) => !b.has(entry))
  const onlyB = [...b].filter((entry) => !a.has(entry))
  expect(
    [...a].sort(),
    `${label}\n  only in first:  ${onlyA.join(', ') || '—'}\n  only in second: ${onlyB.join(', ') || '—'}`,
  ).toEqual([...b].sort())
}

// Endpoint-table token → path. Docs list endpoints as `GET /path` or bare
// `/path` inside backticks; anything else in a backtick (schema names,
// `application/json`, env vars) must NOT parse as a path — hence the anchored
// "optional METHOD then a leading slash" shape.
function pathFromToken(token: string): string | null {
  const match = token.trim().match(/^(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?(\/\S*)$/)
  return match ? match[1]!.replace(/[.,;:]$/, '') : null
}

function backtickedPaths(text: string): Set<string> {
  const paths = new Set<string>()
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const path = pathFromToken(match[1]!)
    if (path) paths.add(path)
  }
  return paths
}

/**
 * Every env var config.ts reads. str/integer/bool('NAME') covers the typed
 * readers; process.env.NAME covers direct reads (that is how NODE_ENV gets in).
 * Dynamic process.env[name] loops are the dotenv plumbing, not config surface —
 * deliberately unmatched.
 */
function envVars(): Set<string> {
  const source = read('src/config.ts')
  const vars = new Set<string>()
  for (const match of source.matchAll(/\b(?:str|integer|bool)\(\s*'([A-Z][A-Z0-9_]*)'/g)) vars.add(match[1]!)
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) vars.add(match[1]!)
  // Test-harness internals, not a knob anyone configures — documenting it would
  // only add noise to the operator table.
  vars.delete('WIKIKIT_SKIP_DOTENV')
  return vars
}

describe('compiled-artifact hazards', () => {
  test('every `bun build --compile` carries the NODE_ENV identity define', () => {
    // Without `--define process.env.NODE_ENV=process.env.NODE_ENV` the bundler
    // replaces that expression with the BUILD machine's value — "development"
    // on a CI runner — as a compile-time constant. The shipped binary never
    // reads the variable again, so systemd starting it with NODE_ENV=production
    // changes nothing and every production gate inverts: the mandatory-
    // configuration check is skipped, .env.defaults is read in production,
    // WIKIKIT_WEBHOOK_ALLOW_PRIVATE falls back to permitting private webhook
    // targets, and a `*`-scope bootstrap key is minted and printed in plaintext
    // on a first boot with no keys.
    //
    // This was verified against this repository's own binary. build-binary.sh
    // additionally RUNS the artifact and requires it to refuse to boot — keep
    // both, because neither alone would have caught it: the source is correct
    // either way, and only the compiled binary knows whether it still reads the
    // variable.
    const IDENTITY_DEFINE = 'process.env.NODE_ENV=process.env.NODE_ENV'
    const offenders: string[] = []
    for (const source of ['build-binary.sh', 'package.json', '.github/workflows/release.yml']) {
      const lines = read(source).split('\n')
      lines.forEach((line, index) => {
        if (!line.includes('--compile')) return
        const trimmed = line.trimStart()
        if (trimmed.startsWith('#') || trimmed.startsWith('//')) return
        // The invocation may wrap across continuation lines — scan a window.
        if (
          !lines
            .slice(index, index + 8)
            .join('\n')
            .includes(IDENTITY_DEFINE)
        ) {
          offenders.push(`${source}:${index + 1} compiles without the identity define`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('drift', () => {
  // Router ↔ registry: every handler ROUTES names must exist in HANDLERS, and
  // every implemented handler must be reachable through a route. An orphan on
  // either side is a route the spec advertises but the server cannot serve (or
  // dead code pretending to be an endpoint).
  test('route handlers in src/http/routes.ts ↔ ROUTES registry are set-equal', () => {
    const declared = new Set(ROUTES.map((route) => route.handler))
    const implemented = new Set(Object.keys(HANDLERS))
    eqSets(declared, implemented, 'ROUTES.handler names vs HANDLERS exports')
  })

  // llms-full.txt carries the complete endpoint table (the full docs agents
  // read instead of the OpenAPI document). Set-EQUALITY, so a stale row is as
  // fatal as a missing one — `/mcp` is the single allowed extra because it
  // deliberately lives outside the registry/OpenAPI (§5.2) yet must be
  // documented.
  test('llms-full.txt endpoint table ↔ ROUTES', () => {
    const full = read('docs/llms-full.txt')
    const headingMatch = full.match(/^#{2,3}\s+Endpoints\b.*$/m)
    expect(headingMatch, 'no "## Endpoints" / "### Endpoints" heading in docs/llms-full.txt').not.toBeNull()
    const lines = full.slice(headingMatch!.index!).split('\n').slice(1)
    const nextHeading = lines.findIndex((line) => /^#{1,3}\s/.test(line))
    const section = lines.slice(0, nextHeading === -1 ? undefined : nextHeading).join('\n')

    const documented = backtickedPaths(section)
    documented.delete('/mcp') // outside ROUTES by design, documented on purpose
    expect(documented.size, 'endpoint table too small / not parsed').toBeGreaterThanOrEqual(5)
    eqSets(documented, routePaths(), 'llms-full.txt Endpoints table vs ROUTES')
  })

  // llms.txt is the INDEX — hand-written, so it can only drift by omission.
  // Scoped to its "Endpoints:" line rather than the whole file: a path
  // mentioned somewhere in prose is not an index entry, and an agent reading
  // the index would not find it.
  test('llms.txt Endpoints line lists every route', () => {
    const line = read('docs/llms.txt')
      .split('\n')
      .find((candidate) => /(^|\W)Endpoints?:/i.test(candidate))
    expect(line, 'no "Endpoints:" line in docs/llms.txt').toBeDefined()
    const mentioned = backtickedPaths(line!)
    for (const path of routePaths()) {
      expect(mentioned.has(path), `route ${path} not listed (backticked) on the docs/llms.txt Endpoints line`).toBe(
        true,
      )
    }
  })

  // Config ↔ docs: every env var config.ts reads must be documented
  // (backtick-wrapped) in all three operator artifacts — zero-config only works
  // when every knob is discoverable, and CONTRACTS §10's own header promises it
  // stays in lockstep.
  test('config env vars are documented in CONFIGURATION.md, llms-full.txt and CONTRACTS.md', () => {
    const vars = envVars()
    expect(vars.size, `expected the full env set from config.ts, parsed only ${vars.size}`).toBeGreaterThanOrEqual(20)
    // Sanity: if the regexes silently stopped matching, the loop below would
    // pass vacuously. These two must always be in there.
    expect(vars.has('WIKIKIT_KEY_PEPPER')).toBe(true)
    expect(vars.has('ANTHROPIC_API_KEY')).toBe(true)

    for (const rel of ['docs/CONFIGURATION.md', 'docs/llms-full.txt', 'docs/CONTRACTS.md']) {
      const doc = read(rel)
      for (const name of vars) {
        expect(doc.includes('`' + name + '`'), `${name} missing from ${rel}`).toBe(true)
      }
    }
  })

  // The env templates are what an operator actually copies — a variable that
  // exists only in prose is a variable they will not discover. NODE_ENV is
  // process-env only (it selects which template tier is read at all), so it is
  // exempt by design.
  test('.env.example and .env.defaults mention every settable env var', () => {
    const vars = [...envVars()].filter((name) => name !== 'NODE_ENV')
    for (const rel of ['.env.example', '.env.defaults']) {
      const template = read(rel)
      for (const name of vars) {
        expect(new RegExp(`^#?\\s*${name}=`, 'm').test(template), `${name} missing from ${rel}`).toBe(true)
      }
    }
  })

  // Every prompt on disk is a versioned, golden-tested artifact whose bytes
  // feed input_hash — so the contract must know it exists. Caught a CONTRACTS
  // §3.4 sentence that still listed three of the five prompt files.
  test('every prompt file is registered in PROMPT_VERSIONS and named in CONTRACTS.md', () => {
    const files = readdirSync(join(root, 'src/llm/prompts'))
      .filter((name) => /\.v\d+\.ts$/.test(name))
      .map((name) => name.replace(/\.ts$/, ''))
    expect(files.length).toBeGreaterThanOrEqual(4)

    const registered = new Set<string>(Object.values(PROMPT_VERSIONS))
    const contracts = read('docs/CONTRACTS.md')
    for (const version of files) {
      expect(registered.has(version), `${version}.ts is not in PROMPT_VERSIONS`).toBe(true)
      const kind = version.split('.')[0]!
      expect(contracts.includes(kind), `prompt ${version} is never named in docs/CONTRACTS.md`).toBe(true)
    }
    // ...and nothing is promised that does not exist.
    expect([...registered].sort()).toEqual(files.sort())
  })

  // The 503 llm_not_configured path names a provider's key, so the map it
  // reads from must stay in step with the keys config.ts actually reads.
  test('LLM_PROVIDER_KEY_ENV matches the keys config.ts reads', () => {
    const source = read('src/config.ts')
    for (const name of Object.values(LLM_PROVIDER_KEY_ENV)) {
      expect(source.includes(`str('${name}')`), `${name} is mapped but never read in src/config.ts`).toBe(true)
    }
  })

  // MCP palette ↔ agent docs: every tool must be documented, and every
  // `wikikit_*` token the docs mention must be a real tool — a documented tool
  // that does not exist sends agents into call-retry loops.
  test('MCP tool names in src/mcp/tools.ts ↔ llms-full.txt tool table', () => {
    const full = read('docs/llms-full.txt')
    const documented = new Set<string>()
    for (const match of full.matchAll(/`(wikikit_[a-z0-9_]+)`/g)) documented.add(match[1]!)
    eqSets(documented, new Set(TOOLS.map((tool) => tool.name)), 'llms-full.txt wikikit_* mentions vs TOOLS palette')
  })

  // The human-facing docs list the palette too, and drifted for a release
  // because nothing checked them.
  test('MCP tool list matches README and CHANGELOG', () => {
    for (const rel of ['README.md', 'CHANGELOG.md']) {
      const documented = new Set<string>()
      for (const match of read(rel).matchAll(/`(wikikit_[a-z0-9_]+)`/g)) documented.add(match[1]!)
      eqSets(documented, new Set(TOOLS.map((tool) => tool.name)), `tool list in ${rel} vs TOOLS palette`)
    }
  })

  // ARCHITECTURE.md carries a table of every SQL function declared by more than
  // one migration and which migration holds the live body. That table is the
  // only place a reader is told that an early migration can be showing them a
  // superseded function — a stale table would reproduce the exact confusion it
  // exists to prevent, so it is generated-checked rather than trusted.
  //
  // Checked by NAME, not by argument list. Postgres identity is name+argtypes
  // and the table's left column carries signatures, but parsing SQL argument
  // types with a regex would be a second, worse parser; the doc's "Declared in"
  // column is likewise left uncontrolled because it records curated nuance a
  // scan cannot see (0010 RENAMES a function into wk_apply_proposal_core_0003
  // rather than declaring it). What must not drift is the set of names a reader
  // needs to be warned about, and which file wins for each.
  test('ARCHITECTURE.md redeclared-function table ↔ src/db/migrations', () => {
    const dir = join(root, 'src/db/migrations')
    const files = readdirSync(dir)
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()
    expect(files.length, 'migrations not found — path or naming changed').toBeGreaterThanOrEqual(30)

    // Both `create function` and `create or replace function` declare a body;
    // 0010 uses the former to add an overload alongside a renamed original.
    const declaredIn = new Map<string, string[]>()
    for (const file of files) {
      const tag = file.slice(0, 4)
      const sql = readFileSync(join(dir, file), 'utf8')
      for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(/gi)) {
        const name = match[1]!
        const tags = declaredIn.get(name) ?? []
        if (!tags.includes(tag)) tags.push(tag)
        declaredIn.set(name, tags)
      }
    }
    expect(declaredIn.size, 'function scan matched nothing — regex drifted').toBeGreaterThanOrEqual(15)

    const redeclared = new Map([...declaredIn].filter(([, tags]) => tags.length > 1))
    expect(redeclared.size, 'no redeclared functions parsed — the scan is broken, not the history').toBeGreaterThan(0)

    const arch = read('docs/ARCHITECTURE.md')
    // Table rows only: `| `name(args)` | 0001, 0003 | **0016** |`
    const documented = new Map<string, string>()
    for (const match of arch.matchAll(/^\|\s*`(wk_[a-z0-9_]+)[^`]*`\s*\|[^|]*\|\s*\*\*(\d{4})\*\*\s*\|/gim)) {
      documented.set(match[1]!, match[2]!)
    }

    eqSets(
      new Set(documented.keys()),
      new Set(redeclared.keys()),
      'ARCHITECTURE.md redeclared-function table vs functions actually declared twice',
    )

    for (const [name, tags] of redeclared) {
      const live = tags[tags.length - 1]!
      expect(documented.get(name), `ARCHITECTURE.md names the wrong live migration for ${name}`).toBe(live)
    }
  })

  // Six tagged releases once shipped with no CHANGELOG entry. The version in
  // package.json is the release being cut, so it must be described.
  test('CHANGELOG has an entry for the current version', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    expect(
      new RegExp(`^##\\s+\\[?${pkg.version.replace(/\./g, '\\.')}\\]?`, 'm').test(read('CHANGELOG.md')),
      `CHANGELOG.md has no "## ${pkg.version}" section`,
    ).toBe(true)
  })

  // The committed OpenAPI snapshot must BE the live document — a generated
  // client builds connectors from it without ever booting a server.
  test('docs/openapi.json snapshot matches buildOpenApi(ROUTES)', () => {
    const snapshot = JSON.parse(read('docs/openapi.json')) as unknown
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(buildOpenApi(ROUTES, { version: VERSION }))))
  })

  // Version flows from package.json (dev) / the build define (binary) — never
  // hardcoded. The deploy health gate compares the version /ready reports
  // against the release tag, so a stale constant fails (or worse, falsely
  // passes) a real deployment. loadConfig() is asserted too: the constant being
  // right does not help if the config surfaces something else.
  test('OpenAPI version === package.json version', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    expect(VERSION).toBe(pkg.version)
    expect(loadConfig().version).toBe(pkg.version)
    expect(buildOpenApi([], { version: pkg.version }).info.version).toBe(pkg.version)
  })
})
