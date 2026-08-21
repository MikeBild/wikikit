// The embedded cockpit against the bundle it was generated from.
//
// `bun build --compile` produces one file, and a readFileSync against
// assets/cockpit inside it resolves to a path that does not exist on the
// operator's machine — so the console travels base64-encoded in
// src/cockpit-embedded.ts, the same way the migrations and the documentation
// already do. A generated artifact that is not drift-checked is a generated
// artifact that is stale, and a stale one here means the binary serves last
// week's console while the checkout shows this week's.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { EMBEDDED_COCKPIT, EMBEDDED_COCKPIT_FILES } from '../../src/cockpit-embedded.ts'

const BUNDLE = join(process.cwd(), 'assets', 'cockpit')

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, found)
    else found.push(full)
  }
  return found
}

function builtFiles(): string[] | null {
  try {
    return walk(BUNDLE).sort()
  } catch {
    return null
  }
}

describe('the embedded cockpit matches assets/cockpit', () => {
  test('a checkout that has never built the console still compiles', () => {
    // The module must exist and typecheck either way — this test is reached
    // only because it does. Zero files is a legitimate state; a missing module
    // is not.
    expect(typeof EMBEDDED_COCKPIT).toBe('object')
    expect(EMBEDDED_COCKPIT_FILES).toBe(Object.keys(EMBEDDED_COCKPIT).length)
  })

  test('every built file is embedded, byte for byte', () => {
    const files = builtFiles()
    if (!files) {
      throw new Error('assets/cockpit is missing — run `bun run build:cockpit`')
    }
    const keys = files.map((file) => relative(BUNDLE, file).split(sep).join('/')).sort()
    expect(Object.keys(EMBEDDED_COCKPIT).sort()).toEqual(keys)

    for (const file of files) {
      const key = relative(BUNDLE, file).split(sep).join('/')
      expect(EMBEDDED_COCKPIT[key], `${key} is not embedded`).toBe(readFileSync(file).toString('base64'))
    }
  })

  test('the shell is there, because everything else is reached through it', () => {
    expect(EMBEDDED_COCKPIT['index.html']).toBeString()
    const shell = Buffer.from(EMBEDDED_COCKPIT['index.html']!, 'base64').toString('utf8')
    expect(shell).toContain('<div id="root"')
    // The pre-paint theme script (CUI-THEME-3) has to be in the served bytes:
    // the CSP hash is computed from them, so a shell without it would ship a
    // policy admitting a script that is not there.
    expect(shell).toContain('wk-cockpit-theme')
  })

  /*
    WEM DIE AUSGELIEFERTEN BYTES GEHÖREN.

    Die Konvention macht die DOM-Verankerungen aller sechs Konsolen absichtlich
    gleich, also findet ein Prüflauf, der auf den falschen Port zeigt, jeden
    Selektor, den er sucht, und meldet die Oberfläche einer Schwester unter
    diesem Produkt. Es ist passiert: bei CodeKit antwortete WorkKit auf dem
    Prüfstands-Port, und der Lauf erzeugte in 156 s acht Verstöße über eine
    Seite, die nie CodeKit war.

    scripts/konvention-check.mjs hält den Marker gegen das GELIEFERTE Dokument;
    dieser Satz hält ihn gegen das GEBAUTE. Das ist nicht dieselbe Aussage, und
    für WikiKit ist der Unterschied scharf: dieser Check misst als einziger der
    Familie gegen zwei Stände, und die Gate-Stufe misst gegen `vite preview`
    über assets/cockpit. Eine Kennung, die den Build nicht überlebt, wäre genau
    dort weg, wo sie gebraucht wird.

    Gehalten gegen den Namen aus package.json statt gegen ein Literal: der
    Marker existiert, um zu sagen, WELCHES Produkt das ist — einer, der vom
    eigenen Namen wegdriften kann, wäre schlechter als keiner.
  */
  test('die gebaute Hülle sagt, welches Produkt sie ist — und sagt das richtige', () => {
    const html = readFileSync(join(BUNDLE, 'index.html'), 'utf8')
    const marker = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(html)?.[1]
    expect(marker, 'die gebaute index.html erklärt <meta name="cockpit-product">').toBeTruthy()

    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string }
    expect(marker!.toLowerCase()).toBe(pkg.name.toLowerCase())

    // Die Quelle ist die einzige Definitionsstelle; der Build darf sie nicht
    // umgeschrieben, verloren oder verdoppelt haben. Vite fasst `<link>`- und
    // `<script>`-Verweise an, `<meta content>` nicht — das ist es, was diese
    // Zeile zu einer Behauptung macht statt zu einer Hoffnung.
    const source = readFileSync(join(process.cwd(), 'apps', 'cockpit', 'index.html'), 'utf8')
    const declared = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(source)?.[1]
    expect(marker).toBe(declared)
    expect([...html.matchAll(/name="cockpit-product"/g)].length, 'genau ein Vorkommen').toBe(1)

    // Und in den Bytes, die das Binary wirklich ausliefert — assets/cockpit
    // liegt im Checkout, src/cockpit-embedded.ts reist mit `bun build --compile`.
    const embedded = Buffer.from(EMBEDDED_COCKPIT['index.html']!, 'base64').toString('utf8')
    expect(/<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(embedded)?.[1]).toBe(marker)
  })

  test('no source map ships to production readers', () => {
    // A .map exposes the console's whole source to anyone who opens devtools
    // on a deployment. Not a secret, but not something to ship without having
    // decided to.
    expect(Object.keys(EMBEDDED_COCKPIT).filter((key) => key.endsWith('.map'))).toEqual([])
  })
})
