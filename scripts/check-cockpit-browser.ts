// The console, in a real browser, at two real widths.
//
// WHY this exists when there are unit tests: nothing in `bun test` has a layout
// engine. A test can prove `DataTable` renders the rows it was given; it cannot
// prove the table scrolls inside its own container rather than pushing the page
// sideways, or that a cell is not clipping its own text at 390px. Those are the
// defects that reach an operator, and they are invisible to every other check
// in this repository.
//
// Three assertions, on every navigable route, at 390×844 and 1280×800:
//
//   1. The document itself does not scroll horizontally (CUI-LAYOUT-1/RESP-1).
//      An app shell whose panes scroll and whose document does not is the whole
//      layout contract; a horizontal document scrollbar means something escaped
//      a `min-w-0` and the page's right-hand side is simply unreachable.
//   2. Every <table> has an ancestor that actually scrolls horizontally
//      (CUI-LAYOUT-3). A wide table is fine. A wide table that widens the page
//      is not.
//   3. No cell clips its own content. `truncate` is a deliberate choice with an
//      ellipsis; a cell whose scrollWidth exceeds its clientWidth without one is
//      text nobody can read and nothing says so.
//
// Deliberately NOT in `bun run gate`: it needs a browser binary, a database and
// a running server, and a gate that cannot run on a fresh checkout is a gate
// people learn to skip. Run it before a release, and after a deploy with
// --remote.
//
//   bun scripts/check-cockpit-browser.ts                     against a local dev stack
//   bun scripts/check-cockpit-browser.ts --remote <url>      against a deployment
//   bun scripts/check-cockpit-browser.ts --remote <url> --space workkit-ops --locale de
//
// Remote mode is READ-ONLY and mints nothing: it is pointed at installations
// this script does not own, and a checker that creates credentials on somebody
// else's deployment is a checker nobody dares run.
import { NAV } from '../apps/cockpit/src/app/nav.ts'
import { DE_PHRASES } from '../apps/cockpit/src/lib/i18n.ts'

interface Viewport {
  name: string
  width: number
  height: number
}

// 390×844 is the phone floor the contract names (CUI-RESP-1). 1280×800 is a
// laptop — included because the two fail differently: the phone catches
// overflow, the laptop catches a sidebar that steals width from a wide table.
const VIEWPORTS: Viewport[] = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'laptop', width: 1280, height: 800 },
]

interface Finding {
  route: string
  viewport: string
  what: string
}

/**
 * Runs inside the page. Returns findings rather than throwing, so one bad route
 * does not hide the next one — a checker that stops at the first failure turns
 * a ten-minute sweep into ten runs.
 *
 * A STRING, deliberately. This file is compiled by the repository's own
 * tsconfig, whose `lib` is ES2023 with no DOM — on purpose, so a server module
 * that reaches for `document` fails to compile. Writing this as a typed
 * function would mean adding DOM to that lib and losing the guarantee for every
 * other file, to typecheck twenty lines that only ever run in Chromium.
 * Playwright evaluates a string expression, so it stays browser code and stays
 * out of the server's type world.
 */
const PROBE = `(() => {
  const findings = []
  const doc = document.documentElement
  if (doc.scrollWidth > doc.clientWidth + 1) {
    findings.push('the document scrolls horizontally (' + doc.scrollWidth + ' > ' + doc.clientWidth + ')')
  }
  for (const table of document.querySelectorAll('table')) {
    let scroller = null
    for (let node = table.parentElement; node; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') { scroller = node; break }
    }
    if (!scroller) findings.push('a table has no horizontally scrolling ancestor')
    if (table.dataset.testid === 'pages-table' && scroller && scroller.scrollWidth > scroller.clientWidth + 1) {
      findings.push('the pages table requires horizontal scrolling (' + scroller.scrollWidth + ' > ' + scroller.clientWidth + ')')
    }
  }
  for (const cell of document.querySelectorAll('td, th')) {
    const style = getComputedStyle(cell)
    // 'truncate' is a deliberate choice with an ellipsis. A cell overflowing
    // WITHOUT one is text nobody can read and nothing on screen says so.
    const truncating = style.textOverflow === 'ellipsis' || style.overflow === 'hidden'
    if (!truncating && cell.scrollWidth > cell.clientWidth + 1) {
      findings.push('a cell clips its own content: ' + (cell.textContent || '').trim().slice(0, 40))
    }
  }
  return findings
})()`

// Exact source phrases are checked in the rendered text nodes, not merely in
// the catalogue. This catches the subtle failure mode where a German phrase
// exists but a custom component prevents it from reaching the translation
// boundary. Dynamic counters use the same English shapes as translateText.
const GERMAN_I18N_PROBE = `(() => {
  const translated = new Set(${JSON.stringify(
    Object.entries(DE_PHRASES)
      .filter(([english, german]) => english !== german)
      .map(([english]) => english.replace(/\s+/g, ' ').trim()),
  )})
  const dynamicEnglish = [
    /^\\d+ quotes cited$/,
    /^\\d+ submitted · \\d+ rejected$/,
    /^\\d+ of \\d+ pages$/,
    /^\\d+ decided$/,
    /^\\d+ open now$/,
    /^In the last \\d+ (?:hours|days)\\.$/,
    /^none open$/,
    /^— each$/,
  ]
  const findings = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || ['SCRIPT', 'STYLE'].includes(parent.tagName)) continue
    const text = (node.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!text) continue
    if (translated.has(text) || dynamicEnglish.some((pattern) => pattern.test(text))) findings.add(text)
  }
  return [...findings]
})()`

async function main(): Promise<void> {
  const remoteFlag = process.argv.indexOf('--remote')
  const base =
    (remoteFlag >= 0 ? process.argv[remoteFlag + 1] : process.env.WIKIKIT_DEV_ORIGIN) ?? 'http://127.0.0.1:4060'
  const spaceFlag = process.argv.indexOf('--space')
  const space = spaceFlag >= 0 ? process.argv[spaceFlag + 1] : undefined
  const localeFlag = process.argv.indexOf('--locale')
  const locale = localeFlag >= 0 ? process.argv[localeFlag + 1] : undefined
  if (locale !== undefined && locale !== 'en' && locale !== 'de') {
    console.error('✗ --locale must be en or de')
    process.exit(2)
  }

  let chromium: typeof import('playwright').chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    console.error('✗ playwright is not installed. `bun add -d playwright && bunx playwright install chromium`')
    process.exit(2)
  }

  // Every navigable route, taken from the same table the console renders its
  // sidebar from — a hand-written list here would go stale the first time a
  // page landed, which is the moment it most needs checking.
  const routes = NAV.map((entry) => entry.to)

  // A signed-out run can only ever see the sign-in splash, so every route below
  // would report "checked nothing". The key comes from the environment and is
  // never a flag: an argument lands in shell history and in the process list of
  // whatever machine this runs on.
  const key = process.env.WIKIKIT_API_KEY ?? ''
  if (!key) {
    console.error('✗ WIKIKIT_API_KEY is not set — a signed-out run can only see the sign-in page.')
    process.exit(2)
  }

  const browser = await chromium.launch()
  const findings: Finding[] = []
  let checked = 0

  /**
   * Sign in the way an operator does, through the funnel, rather than by
   * forging a cookie. Forging one would skip the exact redirect chain a broken
   * `publicUrl` breaks — which is a thing this check should catch, not route
   * around.
   */
  async function signIn(page: import('playwright').Page): Promise<void> {
    await page.goto(`${base.replace(/\/$/, '')}/v1/identity/cockpit-login?return_to=%2Fcockpit%2F`, {
      waitUntil: 'domcontentloaded',
    })
    const apiKeyLink = page.locator('a', { hasText: 'Continue with API key' })
    if ((await apiKeyLink.count()) > 0) await apiKeyLink.first().click()
    await page.fill('input[name="api_key"]', key)
    await page.click('button[type="submit"]')
    await page.waitForURL(/\/cockpit\//, { timeout: 15_000 })
  }

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
      const page = await context.newPage()
      await signIn(page)
      if (locale) {
        await page.evaluate((selected) => localStorage.setItem('wikikit-cockpit-locale', selected), locale)
      }
      for (const route of routes) {
        // `?space=` so a route that needs a wiki has one; without it the shell
        // picks the first available, which is fine but slower and less
        // reproducible across runs.
        const url = new URL(`${base.replace(/\/$/, '')}/cockpit${route === '/' ? '/' : route}`)
        if (space) url.searchParams.set('space', space)
        await page.goto(url.href, { waitUntil: 'networkidle' })

        // A route that bounced to the sign-in splash proves nothing about
        // layout, and reporting it as a pass would be the checker lying.
        const signedOut = await page.locator('[data-testid="sign-in"]').count()
        if (signedOut > 0) {
          findings.push({
            route,
            viewport: viewport.name,
            what: 'not signed in — this run checked nothing on this route',
          })
          continue
        }

        checked += 1
        for (const what of await page.evaluate<string[]>(PROBE)) {
          findings.push({ route, viewport: viewport.name, what })
        }
        if (locale === 'de') {
          const language = await page.getAttribute('html', 'lang')
          if (language !== 'de')
            findings.push({ route, viewport: viewport.name, what: `document language is ${language}` })
          for (const phrase of await page.evaluate<string[]>(GERMAN_I18N_PROBE)) {
            findings.push({ route, viewport: viewport.name, what: `untranslated text: ${phrase}` })
          }
        }
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }

  console.log(`› checked ${checked} route/viewport pairs against ${base}${space ? ` in ${space}` : ''}`)
  if (!findings.length) {
    console.log(`\x1b[32m✓ no layout${locale === 'de' ? ' or German localisation' : ''} findings\x1b[0m`)
    // Said out loud rather than left implied: a green run means these three
    // assertions held, not that the console is correct.
    console.log('  (three assertions: document overflow, table containment, cell clipping)')
    return
  }
  for (const finding of findings) {
    console.error(`\x1b[31m✗\x1b[0m ${finding.viewport} ${finding.route}: ${finding.what}`)
  }
  process.exit(1)
}

await main()
