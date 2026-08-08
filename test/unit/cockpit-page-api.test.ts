// What a page ACTUALLY reaches, against what its navigation entry claims.
//
// CUI-NAV-2 says each entry states the API paths its page reaches "and that
// declaration is compared against what the page actually calls". The
// navigation test only holds half of that: it proves every declared path
// exists in ROUTES. It cannot see a page that grew a request nobody declared —
// which is the drift the rule exists to prevent, because the declaration is
// what a reviewer reads when asking "what does this page touch?".
//
// This closes it, without a browser: pages reach the server only through the
// `wk.*` facade (that is why the facade exists), so the call sites in a page
// module and the path literals in `api/wk.ts` are enough to know.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { entryFor, NAV } from '../../apps/cockpit/src/app/nav.ts'

const root = process.cwd()
const cockpit = join(root, 'apps', 'cockpit', 'src')

/**
 * `wk.<group>.<method>` → the `/v1` paths that method names.
 *
 * Parsed from the facade rather than restated here: a table typed into a test
 * is a table that goes stale, and the whole point is to compare two things
 * neither of which is this file.
 */
function facadePaths(): Map<string, string[]> {
  const source = readFileSync(join(cockpit, 'api', 'wk.ts'), 'utf8')
  const map = new Map<string, string[]>()
  let group: string | null = null
  let method: string | null = null

  for (const line of source.split('\n')) {
    const groupMatch = line.match(/^ {2}(?:\/\*\*.*\*\/\s*)?([a-zA-Z]+): \{\s*$/)
    if (groupMatch) {
      group = groupMatch[1]!
      method = null
      continue
    }
    if (/^ {2}\},?\s*$/.test(line)) {
      group = null
      method = null
      continue
    }
    const methodMatch = line.match(/^ {4}([a-zA-Z]+):/)
    if (methodMatch && group) method = `${group}.${methodMatch[1]!}`
    if (!method) continue
    const paths = [...line.matchAll(/'(\/v1\/[^']*)'/g)].map((match) => match[1]!)
    if (paths.length) map.set(method, [...(map.get(method) ?? []), ...paths])
  }
  return map
}

const FACADE = facadePaths()

/** Which nav entry owns a page module, by the route its file name implies. */
const PAGE_ROUTES: Record<string, string> = {
  'home.tsx': '/',
  'pages.tsx': '/pages',
  'page.tsx': '/pages',
  'page-edit.tsx': '/pages',
  'changes.tsx': '/changes',
  'change.tsx': '/changes',
  'sources.tsx': '/sources',
  'source.tsx': '/sources',
  'decisions.tsx': '/decisions',
  'decision.tsx': '/decisions',
  'search.tsx': '/search',
  'charter.tsx': '/charter',
  'spaces.tsx': '/spaces',
  'api-keys.tsx': '/api-keys',
  'identities.tsx': '/identities',
  'webhooks.tsx': '/webhooks',
  'system.tsx': '/system',
}

function pageModules(): string[] {
  return readdirSync(join(cockpit, 'pages')).filter((name) => name.endsWith('.tsx'))
}

describe('the facade is parsed correctly', () => {
  test('it found the methods the pages call', () => {
    // Guards the parser: a regex that silently matched nothing would make
    // every assertion below vacuously true.
    expect(FACADE.size).toBeGreaterThan(30)
    expect(FACADE.get('changes.approve')).toEqual(['/v1/proposals/{id}/approve'])
    expect(FACADE.get('concepts.history')).toEqual(['/v1/spaces/{space}/concepts/{slug}/history'])
  })

  test('every page module is assigned to a route', () => {
    const unassigned = pageModules().filter((name) => !(name in PAGE_ROUTES))
    expect(unassigned, `page modules with no nav entry:\n${unassigned.join('\n')}`).toEqual([])
  })
})

/**
 * Every documented path a page module reaches.
 *
 * Two ways to reach one, and both count. `wk.*` is the fetch path, which is
 * almost everything. A direct `<a href="/v1/...">` is the other: an export is a
 * DOWNLOAD, and a download is a navigation the browser owns — streaming a
 * whole Markdown tree through the facade would buffer it in memory to hand it
 * straight back to a Blob.
 *
 * Compared by SHAPE, not by parameter name: a link is written
 * `/v1/spaces/${slug}/export` while the route template says `{space}`, and the
 * variable a component happens to call its slug is not a fact about the API.
 * Every parameter — `{space}`, `{id}`, `${anything}` — collapses to `*`, so
 * what is actually compared is the literal segments and their number, which is
 * what identifies a route.
 */
function shapeOf(path: string): string {
  return path
    .split('?')[0]!
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/\{[^}]*\}/g, '*')
}

function reachedBy(name: string): Set<string> {
  const source = readFileSync(join(cockpit, 'pages', name), 'utf8')
  const reached = new Set<string>()

  for (const match of source.matchAll(/\bwk\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)) {
    const call = `${match[1]}.${match[2]}`
    const paths = FACADE.get(call)
    if (!paths) throw new Error(`${name} calls wk.${call}, which the facade does not define`)
    for (const path of paths) reached.add(shapeOf(path))
  }

  // `/v1/spaces/${slug}/export` and friends, reached by href rather than fetch.
  for (const match of source.matchAll(/`(\/v1\/[^`]*)`/g)) reached.add(shapeOf(match[1]!))
  return reached
}

describe('a page reaches only what its navigation entry declares', () => {
  test.each(pageModules().map((name) => [name] as const))('%s', (name) => {
    const route = PAGE_ROUTES[name]!
    const entry = entryFor(route)
    expect(entry, `no nav entry for ${route}`).toBeDefined()

    const declared = new Set(entry!.api.map(shapeOf))
    const undeclared = [...reachedBy(name)].filter((path) => !declared.has(path))
    expect(
      undeclared,
      `${name} reaches paths its "${entry!.to}" nav entry does not declare:\n${undeclared.join('\n')}`,
    ).toEqual([])
  })
})

describe('a navigation entry declares only what its pages reach', () => {
  test('no entry claims a path no page calls', () => {
    // The other direction. A stale declaration is not harmless: it is the
    // answer a reviewer gets when they ask what a page touches, and a path
    // listed here that nothing calls sends them looking for behaviour that
    // was removed.
    const reachedByRoute = new Map<string, Set<string>>()
    for (const [name, route] of Object.entries(PAGE_ROUTES)) {
      const set = reachedByRoute.get(route) ?? new Set<string>()
      for (const path of reachedBy(name)) set.add(path)
      reachedByRoute.set(route, set)
    }

    const stale: string[] = []
    for (const entry of NAV) {
      const reached = reachedByRoute.get(entry.to) ?? new Set<string>()
      for (const path of entry.api) {
        // Paths outside /v1 are the unauthenticated probes the System page
        // fetches directly (/ready, the service descriptor); the facade does
        // not model them because they are not part of the typed surface.
        if (!path.startsWith('/v1/')) continue
        if (!reached.has(shapeOf(path))) stale.push(`${entry.to} declares ${path}, which no page calls`)
      }
    }
    expect(stale, stale.join('\n')).toEqual([])
  })
})

describe('the typed surface goes through the facade', () => {
  test('no page fetches a /v1 path directly', () => {
    // The facade is what makes the declaration above checkable at all: a page
    // reaching /v1 past it is a page whose surface nothing can see, and the
    // generated types stop guarding the fields it reads.
    //
    // Fetching OUTSIDE /v1 is fine and the System page does it: `/ready` and
    // the service descriptor are unauthenticated, untyped and deliberately not
    // part of the agent-facing contract. They are still declared in nav.ts, so
    // the check above still sees them.
    const offenders: string[] = []
    for (const name of pageModules()) {
      const source = readFileSync(join(cockpit, 'pages', name), 'utf8')
      if (/\bapi\.(GET|POST|PUT|DELETE|PATCH)\(/.test(source)) offenders.push(`${name}: calls api.* directly`)
      for (const match of source.matchAll(/(^|[^.\w])fetch\(\s*[`'"]([^`'"]+)/g)) {
        if (match[2]!.startsWith('/v1/')) offenders.push(`${name}: fetches ${match[2]} outside the facade`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
