// Drift guards for the documentation set (drift-guard convention): the docs
// are hand-written, so CI must prove they still describe
// the implementation. Each check parses the ACTUAL source of truth (ROUTES,
// config.ts, the MCP tool palette, buildOpenApi) and asserts the committed
// docs mention it — adding a route/env var/tool without documenting it fails
// here, loudly, with the missing name in the message.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LLM_PROVIDER_KEY_ENV } from '../../src/config.ts'
import { PROMPT_VERSIONS } from '../../src/llm/prompts/index.ts'
import { buildOpenApi } from '../../src/http/openapi.ts'
import { ROUTES } from '../../src/http/routes.ts'
import { TOOLS } from '../../src/mcp/tools.ts'
import { VERSION } from '../../src/version.ts'

const root = join(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const routePaths = () => new Set(ROUTES.map((route) => route.path))

describe('docs drift', () => {
  // llms.txt is a hand-written index — guard its prose "Endpoints:" line so a
  // new route cannot ship without appearing there (backtick-wrapped).
  test('llms.txt Endpoints line lists every route', () => {
    const index = read('docs/llms.txt')
    const line = index.split('\n').find((l) => /(^|\W)Endpoints?:/i.test(l)) ?? ''
    expect(line).not.toBe('')
    const mentioned = new Set<string>()
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const path = match[1]!.match(/\/\S*/)
      if (path) mentioned.add(path[0].replace(/[.,;]$/, ''))
    }
    for (const path of routePaths()) {
      expect(mentioned.has(path), `route ${path} missing from the docs/llms.txt Endpoints line`).toBe(true)
    }
  })

  // llms-full.txt carries a full endpoint table — set-EQUALITY, so a stale
  // row is as fatal as a missing one.
  test('llms-full.txt endpoint table is set-equal with ROUTES', () => {
    const full = read('docs/llms-full.txt')
    const start = full.indexOf('### Endpoints')
    const end = full.indexOf('###', start + '### Endpoints'.length)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const section = full.slice(start, end)
    const documented = new Set([...section.matchAll(/`(\/[^`]*)`/g)].map((match) => match[1]!))
    expect([...documented].sort()).toEqual([...routePaths()].sort())
  })

  // Every env var config.ts reads must be documented in EVERY operator doc.
  // Parsed from source (str/integer/bool helper calls) so a new variable
  // cannot be added without touching the docs. CONTRACTS.md §10 is included
  // because its own header promises it is drift-tested.
  const envVars = () => {
    const source = read('src/config.ts')
    const vars = new Set(
      [...source.matchAll(/\b(?:str|integer|bool)\(\s*'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]!),
    )
    // Read directly via process.env, still operator-facing. (WIKIKIT_SKIP_DOTENV
    // is deliberately absent: it is test-harness internals, not a setting an
    // operator ever sets — documenting it would only add noise.)
    vars.add('NODE_ENV')
    return vars
  }

  test('config env vars are documented in CONFIGURATION.md, llms-full.txt and CONTRACTS.md', () => {
    const vars = envVars()
    expect(vars.size).toBeGreaterThanOrEqual(20)
    for (const rel of ['docs/CONFIGURATION.md', 'docs/llms-full.txt', 'docs/CONTRACTS.md']) {
      const doc = read(rel)
      for (const name of vars) {
        expect(doc.includes('`' + name + '`'), `${name} missing from ${rel}`).toBe(true)
      }
    }
  })

  // The env templates are what an operator actually copies — a variable that
  // exists only in prose is a variable they will not discover. NODE_ENV is
  // process-env only (it selects which tier is read at all), so it is exempt.
  test('.env.example and .env.defaults mention every settable env var', () => {
    const processEnvOnly = new Set(['NODE_ENV'])
    const vars = [...envVars()].filter((name) => !processEnvOnly.has(name))
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

  // The MCP palette is part of the agent-facing contract: every tool must be
  // named (backtick-wrapped) in llms-full.txt, and the docs must not promise
  // tools that do not exist.
  test('MCP tool list matches llms-full.txt', () => {
    const llmsFull = read('docs/llms-full.txt')
    for (const tool of TOOLS) {
      expect(llmsFull.includes('`' + tool.name + '`'), `${tool.name} missing from docs/llms-full.txt`).toBe(true)
    }
    const documented = new Set([...llmsFull.matchAll(/`(wikikit_[a-z_]+)`/g)].map((match) => match[1]!))
    expect([...documented].sort()).toEqual(TOOLS.map((tool) => tool.name).sort())
  })

  // The human-facing docs list the palette too, and drifted for a release
  // because nothing checked them. Set-equality both ways: a tool that ships
  // unlisted is as wrong as a listed tool that does not exist.
  test('MCP tool list matches README and CHANGELOG', () => {
    for (const rel of ['README.md', 'CHANGELOG.md']) {
      const doc = read(rel)
      const documented = new Set([...doc.matchAll(/`(wikikit_[a-z_]+)`/g)].map((match) => match[1]!))
      expect([...documented].sort(), `tool list in ${rel} has drifted`).toEqual(TOOLS.map((tool) => tool.name).sort())
    }
  })

  // Six tagged releases once shipped with no CHANGELOG entry. The version in
  // package.json is the release being cut, so it must be described.
  test('CHANGELOG has an entry for the current version', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    const changelog = read('CHANGELOG.md')
    expect(
      new RegExp(`^##\\s+\\[?${pkg.version.replace(/\./g, '\\.')}\\]?`, 'm').test(changelog),
      `CHANGELOG.md has no "## ${pkg.version}" section`,
    ).toBe(true)
  })

  // The committed OpenAPI snapshot must BE the live document — any generated
  // client builds connectors from it without booting a server.
  test('docs/openapi.json snapshot matches buildOpenApi(ROUTES)', () => {
    const snapshot = JSON.parse(read('docs/openapi.json')) as unknown
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(buildOpenApi(ROUTES, { version: VERSION }))))
  })

  // Version flows from package.json (dev) / the build define (binary) — the
  // spec must never hardcode it.
  test('OpenAPI version is sourced from package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    expect(VERSION).toBe(pkg.version)
    expect(buildOpenApi([], { version: pkg.version }).info.version).toBe(pkg.version)
  })
})
