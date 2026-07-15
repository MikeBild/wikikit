// OpenAPI provider contract (plan §14.2): the committed docs/openapi.json
// snapshot must deep-equal what buildOpenApi(ROUTES) produces at runtime.
//
// WHY a committed snapshot when GET /openapi.json is generated live: the
// snapshot makes every API change a VISIBLE diff in review (SubKit's
// import_connector_from_spec and any OpenAPI tooling build connectors from
// this document — an unreviewed shape change is a broken downstream
// connector), and it lets consumers vendor the spec without running WikiKit.
// Changing the surface therefore requires a deliberate snapshot commit; this
// test is what enforces that.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { buildOpenApi } from '../../src/http/openapi.ts'
import { ROUTES } from '../../src/http/routes.ts'

const SNAPSHOT_URL = new URL('../../docs/openapi.json', import.meta.url)

// One copy-pasteable command (no helper script to drift on its own): rebuild
// the snapshot from the same registry + version this test compares against.
const REGENERATE =
  'docs/openapi.json is stale — regenerate it from the repo root with:\n\n' +
  `  bun -e "const { ROUTES } = await import('./src/http/routes.ts');` +
  ` const { buildOpenApi } = await import('./src/http/openapi.ts');` +
  ` const pkg = JSON.parse(await Bun.file('package.json').text());` +
  ` await Bun.write('docs/openapi.json', JSON.stringify(buildOpenApi(ROUTES, { version: pkg.version }), null, 2) + '\\n')"\n\n` +
  'then commit the diff (a snapshot change IS an API change — review it as one).'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
const live = buildOpenApi(ROUTES, { version: pkg.version })

describe('OpenAPI snapshot contract', () => {
  test('docs/openapi.json exists', () => {
    expect(existsSync(SNAPSHOT_URL), REGENERATE).toBe(true)
  })

  test('docs/openapi.json deep-equals buildOpenApi(ROUTES) at the package.json version', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as unknown
    // Strict deep-equality (undefined ≠ absent): the snapshot is consumed as
    // plain JSON by external tooling, so what the file says is the contract.
    expect(snapshot, REGENERATE).toEqual(JSON.parse(JSON.stringify(live)) as never)
  })

  test('snapshot version tracks package.json (release tag = spec version)', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as { info?: { version?: string } }
    expect(snapshot.info?.version, REGENERATE).toBe(pkg.version)
  })
})
