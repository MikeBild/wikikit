// Der Kennungs-Assert des Konventions-Checks, gehalten an seiner eigenen Form.
//
// WARUM ES DIESE DATEI GIBT
//
// scripts/konvention-check.mjs misst gegen einen Prüfstand, den es selbst
// startet — und beantwortete bis LOCAL-WI-KENNUNG-NICHT-GEPRUEFT nur die Frage
// „antwortet dort etwas?", nicht „antwortet dort WIKIKIT?". Bei CodeKit ist der
// Unterschied real eingetreten: WorkKit hielt CodeKits Prüfstands-Port, und der
// Lauf erzeugte in 156 s acht Verstöße unter CodeKits Namen über eine
// Oberfläche, die nie CodeKit war. Kein Timeout, kein Absturz — ein
// vollständiger, überzeugender, falscher Bericht. Ein Timeout wird untersucht;
// acht Verstöße werden repariert.
//
// Die Familie ist dafür gebaut, ohne es zu wollen: die Konvention macht die
// DOM-Verankerungen aller sechs Konsolen absichtlich gleich, also findet jede
// Zeile des Prüfskripts in jeder Schwesterkonsole etwas vor, und die Prüfstände
// liegen dicht beieinander (CodeKit 4081 · WikiKit 4173 · SubKit 4176 ·
// WatchKit 4183 · WorkKit 4192).
//
// WAS HIER GEPRÜFT WIRD UND WAS NICHT
//
// Nicht, DASS der Assert existiert — das zeigt jeder Lauf. Sondern die drei
// Eigenschaften, die ihn von der ersten Umsetzung der Familie unterscheiden und
// die ein späterer Umbau lautlos wegnehmen könnte: der Sollwert wird ABGELEITET
// statt abgetippt, die Prüfung steht VOR dem Browserstart, und es gibt genau
// einen node-seitigen `fetch` — also genau eine Stelle, die eine Frist braucht.
//
// Muster von WatchKits gleichnamigem Satz übernommen, KOPIERT und nicht
// importiert (§7: kein Shared Code zwischen den Produkten).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const source = readFileSync(join(root, 'scripts', 'konvention-check.mjs'), 'utf8')

/*
  Zeilenkommentare und die Rümpfe der Blockkommentare raus, bevor gezählt wird.

  Nicht Kosmetik: diese Datei erklärt an mehreren Stellen die kaputte Vorform
  („gefragt wurde mit einem `fetch` ohne Zeitgrenze"), und ein Zähler, der die
  Erklärung mitzählt, misst den Text statt des Programms. Die zweite Zeile
  fängt die Fortsetzungszeilen der Blockkommentare dieser Datei, die ohne
  führenden `*` geschrieben sind.
*/
const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

/** Der Rumpf einer Funktion auf oberster Ebene, von ihrem Kopf bis zur `}` in Spalte 0. */
function bodyOf(head: string): string {
  const start = code.indexOf(head)
  expect(start, `${head} ist auffindbar`).toBeGreaterThan(0)
  const end = code.indexOf('\n}\n', start)
  expect(end, `${head} hat ein Ende`).toBeGreaterThan(start)
  return code.slice(start, end)
}

describe('der Kennungs-Assert leitet ab, statt abzutippen', () => {
  test('apps/cockpit/index.html ist die einzige Definitionsstelle', () => {
    const shell = readFileSync(join(root, 'apps', 'cockpit', 'index.html'), 'utf8')
    const treffer = [...shell.matchAll(/<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/g)]
    expect(treffer.length, 'genau ein <meta name="cockpit-product"> in der Quelle').toBe(1)

    // Und der Wert ist der Produktname, nicht irgendeiner: ein Marker, der vom
    // eigenen Namen wegdriften kann, wäre schlechter als keiner.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(treffer[0]![1]!.toLowerCase()).toBe(pkg.name.toLowerCase())
  })

  test('der Sollwert kommt aus der Datei und steht nirgends im Assert', () => {
    const body = bodyOf('function assertPruefstandsKennung(html, wo)')

    // Abgeleitet: gelesen, nicht geschrieben — und zwar aus derselben Konstante,
    // gegen die auch classifyPruefstand() vergleicht.
    expect(code).toContain("const COCKPIT_SOURCE_HTML = 'apps/cockpit/index.html'")
    expect(body).toContain('const quelle = new URL(`../${COCKPIT_SOURCE_HTML}`, import.meta.url)')
    expect(body).toContain("const erwartet = markerIn(readFileSync(quelle, 'utf8'))")

    /*
      Und nirgends abgetippt. Geprüft wird der RUMPF und nicht die ganze Datei:
      „WikiKit" steht dort legitim als PRODUCT_NAME, weil §6 die Schreibweise im
      Fließtext prüft — und genau deshalb darf der Kennungs-Assert diese
      Konstante auch nicht BENUTZEN. Eine Kennung, die zugleich Prüfgegenstand
      ist, macht aus jedem echten §6-Verstoß ein „das ist gar nicht WikiKit" und
      misst danach nichts mehr. Aus demselben Grund nicht der <title>.
    */
    const marker = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(
      readFileSync(join(root, 'apps', 'cockpit', 'index.html'), 'utf8'),
    )?.[1]
    expect(marker, 'die Quelle trägt den Marker').toBeTruthy()
    expect(body.includes(`'${marker}'`) || body.includes(`"${marker}"`), 'kein Literal des Markers').toBe(false)
    expect(body).not.toContain('PRODUCT_NAME')
    expect(body).not.toContain('<title>WikiKit')
  })

  test('die drei Zweige sagen drei verschiedene Sätze', () => {
    const body = bodyOf('function assertPruefstandsKennung(html, wo)')
    // Fremde Konsole — und sie wird BENANNT, nicht nur zurückgewiesen. Das ist
    // der Fortschritt gegenüber der ersten Umsetzung: „irgendetwas Fremdes"
    // schickt den Leser suchen, „sein Titel lautet …" nicht.
    expect(body).toContain('Sein Titel lautet')
    expect(body).toContain('das ist nicht ${erwartet}, sondern ${geliefert}')
    // Umbenanntes ATTRIBUT ist ein Befund über DIESES Repository und keine
    // Aussage über das Gegenüber — die Meldung, die andernfalls in die falsche
    // Richtung zeigt.
    expect(body).toContain('Befund über DIESES Repository und keine Aussage über das Gegenüber')
  })

  test('geprüft wird vor dem Browserstart', () => {
    // Ein Browser, der schon läuft, hat eine fremde Oberfläche vor sich, auf der
    // jeder Selektor dieses Skripts etwas findet. Die Reihenfolge IST die
    // Zusicherung.
    const kennung = code.indexOf('assertPruefstandsKennung(shellHtml, wo)')
    const browser = code.indexOf('await chromium.launch()')
    expect(kennung, 'der Assert wird aufgerufen').toBeGreaterThan(0)
    expect(browser, 'der Browser startet').toBeGreaterThan(0)
    expect(kennung, 'die Kennung wird vor dem Browserstart geprüft').toBeLessThan(browser)

    // Derselbe Abruf trägt auch die Prüfstands-Erkennung. Ein zweiter Abruf wäre
    // eine zweite Stelle mit eigener Frist, ohne etwas zu gewinnen: nachgemessen
    // liefert marksIn() über diesen Text in beiden Ständen (dev und preview)
    // dieselben zwei Verweise wie die frühere Messung im DOM.
    expect(code).toContain('pruefstand = classifyPruefstand(marksIn(shellHtml))')
    expect(code).not.toContain('classifyPruefstand(shell.delivered)')
  })

  test('ein fremdes Gegenüber endet mit „nicht gemessen" und nicht mit einem Bericht', () => {
    // 0 ist „gemessen und grün", 1 ist „gemessen und rot", 2 ist „nicht
    // gemessen". Ein fremdes Cockpit ist kein Konventionsverstoß, sondern ein
    // Lauf, der nicht stattgefunden hat — der Unterschied ist die ganze Lehre
    // aus den acht Verstößen bei CodeKit.
    const body = bodyOf('function assertPruefstandsKennung(html, wo)')
    expect(body).toContain('throw new Error(')
    expect(code).toContain('await main().catch((error) => {')
    expect(code).toContain('nicht gemessen')
    expect(code).toContain('process.exit(2)')
  })

  test('es gibt genau einen node-seitigen fetch, und der trägt eine Frist', () => {
    /*
      Eine Frist ist eine Eigenschaft der AUFRUFSTELLE. Jede weitere Stelle ist
      eine, die man vergessen kann — und ein hängender Lauf ist als Gate-Stufe
      der schlechteste der drei Ausgänge, weil ihn jemand abbricht und „flaky"
      nennt. Der zweite `fetch` in der Datei läuft im BROWSER (im Rumpf von
      checkFavicon(), serialisiert an page.evaluate) und hängt an playwrights
      Lebensdauer des Frames, nicht an node.
    */
    const browserSeitig = code.indexOf("fetch(href, { cache: 'no-store' })")
    expect(browserSeitig, 'der Favicon-Abruf in der Seite ist auffindbar').toBeGreaterThan(0)

    const stellen = [...code.matchAll(/\bfetch\s*\(/g)].map((match) => match.index!)
    const nodeSeitig = stellen.filter((at) => at !== browserSeitig)
    expect(nodeSeitig.length, `node-seitige fetch-Aufrufe: ${nodeSeitig.length}, erwartet 1`).toBe(1)

    const getWithin = bodyOf('async function getWithin(url, timeoutMs)')
    expect(getWithin).toContain('await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })')
    // Der Körper wird UNTER demselben Signal gelesen: „die Kopfzeilen kamen" ist
    // nicht dasselbe wie „der Server antwortet", und die Lücke zwischen beidem
    // ist der zweite Hänger.
    expect(getWithin).toContain('return { ok: response.ok, body: await response.text() }')

    const start = code.indexOf('async function getWithin(url, timeoutMs)')
    expect(nodeSeitig[0]).toBeGreaterThan(start)
    expect(nodeSeitig[0]).toBeLessThan(start + getWithin.length)
  })
})
