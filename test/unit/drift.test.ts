// Drift guards (plan §8, drift-guard convention): keep
// the router, the OpenAPI registry, the LLM docs, the config docs and the MCP
// tool palette in sync with the implementation. These fail in CI when any of
// them diverge — removing a route, adding an env var without documenting it,
// or renaming an MCP tool must turn CI red, never ship silently.
//
// WHY source/docs are parsed with regexes instead of importing richer
// metadata: docs are hand-maintained prose (llms.txt/llms-full.txt are the
// product's self-description for agents) and config.ts reads process.env
// imperatively. Parsing the artifacts that actually ship is the whole point —
// a drift test that reads a helper export would only prove the helper agrees
// with itself.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { loadConfig } from '../../src/config.ts'
import { buildOpenApi } from '../../src/http/openapi.ts'
import { HANDLERS, ROUTES } from '../../src/http/routes.ts'
import { TOOLS } from '../../src/mcp/tools.ts'

const read = (rel: string): string => {
  try {
    return readFileSync(new URL(rel, import.meta.url), 'utf8')
  } catch {
    throw new Error(`${rel.replace('../../', '')} is missing — it is a committed release artifact (plan §8)`)
  }
}

const routePaths = (): Set<string> => new Set(ROUTES.map((route) => route.path))

// Set-equality with a message that names the drift in both directions —
// "only in first/second" beats a wall of sorted arrays when 29 routes diverge
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

describe('drift', () => {
  // (a) Router ↔ registry: every handler the ROUTES table names must exist in
  // HANDLERS, and every implemented handler must be reachable through a route.
  // An orphan on either side is a route the spec advertises but the server
  // cannot serve (or dead code pretending to be an endpoint).
  test('route handlers in src/http/routes.ts ↔ ROUTES registry are set-equal', () => {
    const declared = new Set(ROUTES.map((route) => route.handler))
    const implemented = new Set(Object.keys(HANDLERS))
    eqSets(declared, implemented, 'ROUTES.handler names vs HANDLERS exports')
  })

  // (b) llms-full.txt carries a complete endpoint table (the full docs agents
  // read instead of the OpenAPI document). It must list exactly the ROUTES
  // surface — `/mcp` is the single allowed extra because it deliberately lives
  // outside the registry/OpenAPI (§5.2) yet absolutely must be documented.
  test('llms-full.txt endpoint table ↔ ROUTES', () => {
    const full = read('../../docs/llms-full.txt')
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

  // (b2) llms.txt is the INDEX — hand-written, so it can only drift by
  // omission. Every route must be mentioned (backticked) somewhere in it;
  // extras (e.g. `/mcp`, doc URLs) are welcome in an index.
  test('llms.txt endpoint list covers every ROUTES path', () => {
    const mentioned = backtickedPaths(read('../../docs/llms.txt'))
    for (const path of routePaths()) {
      expect(mentioned.has(path), `route ${path} not listed (backticked) in docs/llms.txt`).toBe(true)
    }
  })

  // (c) Config ↔ docs: every env var config.ts reads must be documented
  // (backtick-wrapped) in CONFIGURATION.md AND llms-full.txt — zero-config
  // only works when every knob is discoverable, and CONTRACTS §10 pins the
  // three artifacts in lockstep.
  test('every env var read in src/config.ts is documented in CONFIGURATION.md and llms-full.txt', () => {
    const source = readFileSync(new URL('../../src/config.ts', import.meta.url), 'utf8')
    const envs = new Set<string>()
    // str/integer/bool('NAME', ...) covers the typed readers; process.env.NAME
    // covers direct reads (NODE_ENV). Dynamic process.env[name] loops are the
    // dotenv plumbing, not config surface — deliberately unmatched.
    for (const match of source.matchAll(/\b(?:str|integer|bool)\(\s*'([A-Z][A-Z0-9_]*)'/g)) envs.add(match[1]!)
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) envs.add(match[1]!)
    // Test-harness internals, not a knob anyone configures — documenting it
    // would only add noise to the operator table.
    envs.delete('WIKIKIT_SKIP_DOTENV')

    expect(envs.size, `expected the full env set from config.ts, parsed only ${envs.size}`).toBeGreaterThanOrEqual(20)
    expect(envs.has('WIKIKIT_KEY_PEPPER')).toBe(true)
    expect(envs.has('ANTHROPIC_API_KEY')).toBe(true)

    const configuration = read('../../docs/CONFIGURATION.md')
    const full = read('../../docs/llms-full.txt')
    for (const env of envs) {
      expect(configuration.includes(`\`${env}\``), `${env} not documented in docs/CONFIGURATION.md`).toBe(true)
      expect(full.includes(`\`${env}\``), `${env} not documented in docs/llms-full.txt`).toBe(true)
    }
  })

  // (d) Version: the OpenAPI info.version is sourced from package.json via
  // config/VERSION — never hardcoded. The deploy health gate compares the
  // /ready version against the release tag, so a stale constant would fail
  // (or worse, falsely pass) real deployments.
  test('OpenAPI version === package.json version', () => {
    const pkg = JSON.parse(read('../../package.json')) as { version: string }
    expect(loadConfig().version).toBe(pkg.version)
    expect(buildOpenApi(ROUTES, { version: pkg.version }).info.version).toBe(pkg.version)
  })

  // (e) MCP palette ↔ docs: every tool must be documented, and every
  // `wikikit_*` token the docs mention must be a real tool — a documented
  // tool that does not exist sends agents into call-retry loops.
  test('MCP tool names in src/mcp/tools.ts ↔ llms-full.txt tool table', () => {
    const full = read('../../docs/llms-full.txt')
    const documented = new Set<string>()
    for (const match of full.matchAll(/`(wikikit_[a-z0-9_]+)`/g)) documented.add(match[1]!)
    const implemented = new Set(TOOLS.map((tool) => tool.name))
    eqSets(documented, implemented, 'llms-full.txt wikikit_* tool mentions vs TOOLS palette')
  })
})
