// Der Basispfad des Favicons, maschinell festgehalten.
//
// Der Cockpit-Verweis auf das Favicon hat GENAU EINE richtige Schreibweise und
// zwei Arten, falsch zu sein — beide sehen in der Quelle aus wie Sorgfalt:
//
//  - „/favicon.svg" in der Quelle ist richtig. Vite stellt beim Bauen `base`
//    davor, also steht in der gebauten Fassung „/cockpit/favicon.svg".
//  - „/cockpit/favicon.svg" in der QUELLE ist die teuflische Variante: Vite
//    stellt `base` trotzdem davor, die gebaute Fassung sagt dann
//    „/cockpit/cockpit/favicon.svg", und der Server antwortet darauf mit der
//    SPA-Rückfalllinie — 200, text/html, ein Reiter ohne Icon. Ein Assert, der
//    nur den Statuscode liest, nickt das ab.
//  - „./favicon.svg" löst gegen die aktuelle Adresse auf und geht auf jeder
//    Unterseite woanders hin.
//
// Zwei Sätze, eine Regel: die Quelle beginnt NICHT mit dem Basispfad, und die
// gebaute Fassung ist genau Basispfad + Quelle. Das fängt beide Fehlerarten,
// und es fängt sie hier — ohne Browser, ohne Server, in `bun test`.
//
// Die gebaute Fassung liegt committet in assets/cockpit und wird von
// `bun run check:cockpit-drift` gegen die Quelle gehalten; sie ist damit ein
// belastbarer Messpunkt und keine Momentaufnahme irgendeines Rechners.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const viteConfig = readFileSync(join(root, 'apps', 'cockpit', 'vite.config.ts'), 'utf8')
const sourceHtml = readFileSync(join(root, 'apps', 'cockpit', 'index.html'), 'utf8')
const builtHtml = readFileSync(join(root, 'assets', 'cockpit', 'index.html'), 'utf8')

/** Der Basispfad, aus der Vite-Konfiguration statt aus dieser Datei. */
const base = viteConfig.match(/\bbase:\s*'([^']+)'/)?.[1]

/** Der href des Favicon-Verweises, oder null wenn keiner dasteht. */
function faviconHref(html: string): string | null {
  const link = html.match(/<link\b[^>]*\brel="[^"]*\bicon\b[^"]*"[^>]*>/i)?.[0]
  return link?.match(/\bhref="([^"]+)"/i)?.[1] ?? null
}

describe('der Favicon-Verweis trägt den Basispfad genau einmal', () => {
  test('die Vite-Konfiguration nennt einen Basispfad', () => {
    // Sichert die beiden Regex oben ab: eine Konfiguration, die nicht mehr
    // passt, würde die Sätze darunter stillschweigend wahr machen.
    expect(base).toBeString()
    expect(base!.startsWith('/')).toBe(true)
    expect(base!.endsWith('/')).toBe(true)
  })

  test('Quelle und gebaute Fassung verweisen überhaupt auf ein Icon', () => {
    expect(faviconHref(sourceHtml)).toBeString()
    expect(faviconHref(builtHtml)).toBeString()
  })

  test('die Quelle schreibt den Basispfad NICHT selbst hin', () => {
    const href = faviconHref(sourceHtml)!
    expect(
      href.startsWith(base!),
      `apps/cockpit/index.html trägt href="${href}" — Vite stellt „${base}" beim Bauen selbst davor, hier steht es doppelt`,
    ).toBe(false)
    expect(href.startsWith('/'), `href="${href}" ist dokumentrelativ und zeigt je nach Unterseite woandershin`).toBe(
      true,
    )
  })

  test('die gebaute Fassung ist genau Basispfad + Quelle', () => {
    const source = faviconHref(sourceHtml)!
    const built = faviconHref(builtHtml)!
    expect(built).toBe(`${base}${source.slice(1)}`)
  })
})
