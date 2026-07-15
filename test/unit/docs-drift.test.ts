// Drift guards for the documentation set (SlideKit test/unit/drift.test.mjs
// pattern): the docs are hand-written, so CI must prove they still describe
// the implementation. Each check parses the ACTUAL source of truth (ROUTES,
// config.ts, the MCP tool palette, buildOpenApi) and asserts the committed
// docs mention it — adding a route/env var/tool without documenting it fails
// here, loudly, with the missing name in the message.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  // Every env var config.ts reads must be documented in BOTH operator docs.
  // Parsed from source (str/integer/bool helper calls) so a new variable
  // cannot be added without touching the docs.
  test('config env vars are documented in CONFIGURATION.md and llms-full.txt', () => {
    const source = read('src/config.ts')
    const vars = new Set(
      [...source.matchAll(/\b(?:str|integer|bool)\(\s*'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]!),
    )
    vars.add('NODE_ENV') // read directly via process.env, still operator-facing
    expect(vars.size).toBeGreaterThanOrEqual(20)
    const configurationMd = read('docs/CONFIGURATION.md')
    const llmsFull = read('docs/llms-full.txt')
    for (const name of vars) {
      expect(configurationMd.includes('`' + name + '`'), `${name} missing from docs/CONFIGURATION.md`).toBe(true)
      expect(llmsFull.includes('`' + name + '`'), `${name} missing from docs/llms-full.txt`).toBe(true)
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

  // The committed OpenAPI snapshot must BE the live document — SubKit builds
  // connectors from it without booting a server.
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
