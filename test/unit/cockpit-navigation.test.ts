// The navigation table, held against the routes it claims to reach.
//
// CUI-NAV-1/2. A navigation table nobody checks is a comment: it drifts the
// first time a page grows a request, and the drift is invisible until an
// operator opens a page and watches half of it 403. So every entry states the
// paths its page reaches and the scope that reveals it, and both are compared
// against ROUTES — the thing that actually decides them.
//
// The imports are the point: nav.ts is DOM-free so this file can read it
// without a browser, and ROUTES is the server's own registry rather than a
// restatement of it.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NAV, GROUPS, entryFor } from '../../apps/cockpit/src/app/nav.ts'
import { isProxied } from '../../apps/cockpit/dev-proxy.ts'
import { holdsScope } from '../../src/http/auth.ts'
import { ROUTES } from '../../src/http/routes.ts'

const routePaths = new Set(ROUTES.map((route) => route.path))
const router = readFileSync(join(process.cwd(), 'apps', 'cockpit', 'src', 'router.tsx'), 'utf8')

/**
 * Paths served outside the ROUTES registry, by the OAuth raw mount. They are
 * documented in src/oauth/openapi.ts rather than in ROUTES, so a nav entry may
 * name one — but only one of these, listed here so the exemption is a decision
 * and not a hole.
 */
const RAW_MOUNT_PATHS = new Set(['/v1/session', '/v1/identity/cockpit-login'])

describe('every declared path exists', () => {
  test.each(NAV.map((entry) => [entry.to, entry] as const))('%s reaches only documented paths', (_to, entry) => {
    const unknown = entry.api.filter((path) => !routePaths.has(path) && !RAW_MOUNT_PATHS.has(path))
    expect(unknown).toEqual([])
  })

  test('no entry declares an empty API surface', () => {
    // A page that reaches nothing is a page with nothing on it. If one ever
    // legitimately exists, this test is the place to say so out loud.
    for (const entry of NAV) expect(entry.api.length, `${entry.to} declares no paths`).toBeGreaterThan(0)
  })
})

describe('every declared scope matches what the server demands', () => {
  test.each(NAV.map((entry) => [entry.to, entry] as const))('%s is revealed by a scope that opens it', (_to, entry) => {
    // The entry's scope must actually open at least one of its paths —
    // otherwise the sidebar reveals a page whose every request will be refused.
    const reachable = entry.api
      .filter((path) => routePaths.has(path))
      .map((path) => ROUTES.filter((route) => route.path === path))
      .flat()
    if (reachable.length === 0) return
    if (entry.scope === null) {
      // A null scope is a CLAIM that every path is public.
      for (const route of reachable) expect(route.scope, `${route.path} is not public`).toBeNull()
      return
    }
    const opened = reachable.filter((route) => route.scope === null || holdsScope([entry.scope!], route.scope))
    expect(opened.length, `${entry.to}: scope ${entry.scope} opens none of its routes`).toBeGreaterThan(0)
  })

  test('a page whose only paths need admin says admin', () => {
    // The inverse of the check above: an entry must not under-claim, or the
    // sidebar offers a reader a page that is entirely refused.
    for (const entry of NAV) {
      const reachable = ROUTES.filter((route) => entry.api.includes(route.path))
      if (!reachable.length || entry.scope === null) continue
      const anyOpen = reachable.some((route) => route.scope === null || holdsScope([entry.scope!], route.scope))
      expect(anyOpen, `${entry.to} claims ${entry.scope} but every route refuses it`).toBe(true)
    }
  })
})

describe('the table and the router agree', () => {
  test('every nav entry has a route', () => {
    for (const entry of NAV) {
      expect(router.includes(`path: '${entry.to}'`), `router.tsx has no route for ${entry.to}`).toBe(true)
    }
  })

  test('every routed path is reachable from the navigation', () => {
    // A detail route is reached FROM its section rather than from the sidebar,
    // so it counts as reachable when entryFor resolves it to an entry.
    // `basepath: '/cockpit'` is where the console is MOUNTED, not a route.
    const paths = [...router.matchAll(/(?<!base)path: '([^']+)'/g)].map((match) => match[1]!)
    for (const path of paths) {
      const concrete = path.replace(/\$\w+/g, 'x')
      expect(entryFor(concrete), `${path} is not reachable from any nav entry`).toBeDefined()
    }
  })

  test('entryFor prefers the longest match, so a detail page is not the index', () => {
    expect(entryFor('/pages')?.to).toBe('/pages')
    expect(entryFor('/pages/onboarding')?.to).toBe('/pages')
    expect(entryFor('/decisions/proposals/abc')?.to).toBe('/decisions')
    // The home entry is exact: without that, every path would match '/'.
    expect(entryFor('/')?.to).toBe('/')
    expect(entryFor('/sources')?.to).toBe('/sources')
  })
})

describe('the groups', () => {
  test('every entry sits in a declared group', () => {
    const ids = new Set(GROUPS.map((group) => group.id))
    for (const entry of NAV) expect(ids.has(entry.group), `${entry.to} is in unknown group ${entry.group}`).toBe(true)
  })

  test('every group holds at least one entry', () => {
    for (const group of GROUPS) {
      expect(
        NAV.some((entry) => entry.group === group.id),
        `group ${group.id} is empty`,
      ).toBe(true)
    }
  })

  test('exactly one group is separated — the installation block', () => {
    const separated = GROUPS.filter((group) => group.separated)
    expect(separated.map((group) => group.id)).toEqual(['installation'])
  })
})

describe('the dev server forwards everything the console reaches', () => {
  test('every declared path is proxied by `bun run dev:cockpit`', () => {
    // The same declaration, read for a different purpose. `entry.api` already
    // has to name every path a page reaches, so it is also the complete list of
    // what Vite must forward to the running server — and a path missing from
    // the proxy is not a 404 an operator would recognise, it is Vite's SPA
    // fallback answering with 200 text/html. The page then fails to parse its
    // own JSON and shows its error state, on every dev run, for as long as
    // nobody thinks to compare two lists by hand.
    for (const entry of NAV) {
      for (const path of entry.api) {
        expect(isProxied(path), `${entry.to} reaches ${path}, which dev-proxy.ts does not forward`).toBe(true)
      }
    }
  })

  test('no proxy prefix swallows the console itself', () => {
    // The console is served at /cockpit/ by Vite. A prefix that captured it
    // would forward the app's own assets to the API and serve nothing.
    expect(isProxied('/cockpit/')).toBe(false)
    expect(isProxied('/')).toBe(false)
  })
})

describe('the nav fragments page agents wrote were all merged', () => {
  test('every nav-entries fragment appears in NAV', () => {
    // Page agents drop a fragment rather than editing nav.ts, so ten of them
    // never touch one file. This is what proves the integrator merged them.
    const dir = join(process.cwd(), 'apps', 'cockpit', 'nav-entries')
    let fragments: string[]
    try {
      fragments = readdirSync(dir).filter((name) => name.endsWith('.json'))
    } catch {
      return // no fragments checked in is a legitimate state
    }
    for (const name of fragments) {
      const fragment = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { to: string }
      expect(
        NAV.some((entry) => entry.to === fragment.to),
        `${name} declares ${fragment.to}, which is not in NAV`,
      ).toBe(true)
    }
  })
})
