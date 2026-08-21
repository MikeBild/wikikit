// The favicon's base path, held mechanically.
//
// The cockpit's favicon reference has EXACTLY ONE right spelling and two ways of
// being wrong, both of which look like care in the source:
//
//  - `/favicon.svg` in the source is right. Vite prepends `base` at build time,
//    so the built version reads `/cockpit/favicon.svg`.
//  - `/cockpit/favicon.svg` in the SOURCE is the nasty one: Vite prepends `base`
//    anyway, the built version says `/cockpit/cockpit/favicon.svg`, and the
//    server answers that with the SPA fallback — 200, text/html, a tab without
//    an icon. An assert that only reads the status code nods it through.
//  - `./favicon.svg` resolves against the current address and points somewhere
//    else on every sub-page.
//
// Two assertions, one rule: the source does NOT start with the base path, and
// the built version is exactly base path + source. That catches both failure
// modes, and it catches them here — no browser, no server, inside `bun test`.
//
// The built version is committed under assets/cockpit and held against the
// source by `bun run check:cockpit-drift`, so it is a solid measuring point
// rather than a snapshot of somebody's machine.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const viteConfig = readFileSync(join(root, 'apps', 'cockpit', 'vite.config.ts'), 'utf8')
const sourceHtml = readFileSync(join(root, 'apps', 'cockpit', 'index.html'), 'utf8')
const builtHtml = readFileSync(join(root, 'assets', 'cockpit', 'index.html'), 'utf8')

/** The base path, from the Vite config rather than from this file. */
const base = viteConfig.match(/\bbase:\s*'([^']+)'/)?.[1]

/** The href of the favicon reference, or null when there is none. */
function faviconHref(html: string): string | null {
  const link = html.match(/<link\b[^>]*\brel="[^"]*\bicon\b[^"]*"[^>]*>/i)?.[0]
  return link?.match(/\bhref="([^"]+)"/i)?.[1] ?? null
}

describe('the favicon reference carries the base path exactly once', () => {
  test('the Vite config names a base path', () => {
    // Guards the two regexes above: a config that no longer matches would make
    // the assertions below silently true.
    expect(base).toBeString()
    expect(base!.startsWith('/')).toBe(true)
    expect(base!.endsWith('/')).toBe(true)
  })

  test('source and built version reference an icon at all', () => {
    expect(faviconHref(sourceHtml)).toBeString()
    expect(faviconHref(builtHtml)).toBeString()
  })

  test('the source does NOT write the base path itself', () => {
    const href = faviconHref(sourceHtml)!
    expect(
      href.startsWith(base!),
      `apps/cockpit/index.html carries href="${href}" — Vite prepends "${base}" at build time, so it is doubled here`,
    ).toBe(false)
    expect(href.startsWith('/'), `href="${href}" is document-relative and points elsewhere per sub-page`).toBe(true)
  })

  test('the built version is exactly base path + source', () => {
    const source = faviconHref(sourceHtml)!
    const built = faviconHref(builtHtml)!
    expect(built).toBe(`${base}${source.slice(1)}`)
  })
})
