// The console, in a real browser, at four release widths.
//
// WHY this exists when there are unit tests: nothing in `bun test` has a layout
// engine. A test can prove `DataTable` renders the rows it was given; it cannot
// prove the table scrolls inside its own container rather than pushing the page
// sideways, or that a cell is not clipping its own text at 390px. Those are the
// defects that reach an operator, and they are invisible to every other check
// in this repository.
//
// The assertions run on every navigable route at phone, tablet and laptop widths:
//
//   1. The document itself does not scroll horizontally (CUI-LAYOUT-1/RESP-1).
//      An app shell whose panes scroll and whose document does not is the whole
//      layout contract; a horizontal document scrollbar means something escaped
//      a `min-w-0` and the page's right-hand side is simply unreachable.
//   2. Every <table> fits its visible container without horizontal scrolling
//      (CUI-LAYOUT-3). Secondary columns collapse responsively; the primary
//      identity and row actions remain visible.
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
//   bun scripts/check-cockpit-browser.ts --remote <url> --local-assets assets/cockpit
//   bun scripts/check-cockpit-browser.ts --screenshots <directory>
//
// Remote mode is READ-ONLY and mints nothing: it is pointed at installations
// this script does not own, and a checker that creates credentials on somebody
// else's deployment is a checker nobody dares run.
import { mkdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { NAV } from '../apps/cockpit/src/app/nav.ts'
import { DE_PHRASES } from '../apps/cockpit/src/lib/i18n.ts'

interface Viewport {
  name: string
  width: number
  height: number
}

// The four widths are the release matrix. The narrow pair catch controls that
// push past their surface; the wide pair catch tables that waste or steal the
// room an operator actually has.
const VIEWPORTS: Viewport[] = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1920, height: 1080 },
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
    const container = table.parentElement
    if (table.scrollWidth > table.clientWidth + 1 || (container && container.scrollWidth > container.clientWidth + 1)) {
      findings.push((table.dataset.testid || 'a table') + ' exceeds its surface')
    }
  }
  for (const cell of document.querySelectorAll('td, th')) {
    const style = getComputedStyle(cell)
    if (style.display === 'none') continue
    // 'truncate' is a deliberate choice with an ellipsis. A cell overflowing
    // WITHOUT one is text nobody can read and nothing on screen says so.
    const truncating = style.textOverflow === 'ellipsis' || style.overflow === 'hidden'
    if (!truncating && cell.scrollWidth > cell.clientWidth + 1) {
      findings.push(
        'a cell clips its own content: ' +
          (cell.dataset.testid || cell.tagName.toLowerCase()) +
          ' (' +
          cell.scrollWidth +
          ' > ' +
          cell.clientWidth +
          ') ' +
          (cell.textContent || '').trim().slice(0, 40),
      )
    }
  }
  const ids = new Map()
  for (const element of document.querySelectorAll('[data-testid]')) {
    const id = element.getAttribute('data-testid')
    if (!id) continue
    ids.set(id, (ids.get(id) || 0) + 1)
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(id)) {
      findings.push('opaque identifier in data-testid: ' + id)
    }
  }
  for (const [id, count] of ids) {
    if (count > 1) findings.push('duplicate data-testid: ' + id + ' (' + count + ' elements)')
  }
  const interactive = 'a,button,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"]'
  for (const element of document.querySelectorAll(interactive)) {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    if (!element.getAttribute('data-testid')) {
      findings.push('interactive element has no data-testid: ' + element.tagName.toLowerCase())
    }
    if (element.tagName === 'BUTTON' && element.getAttribute('aria-label')) {
      const visibleText = (element.textContent || '').trim()
      const icons = element.querySelectorAll('svg').length
      if (!visibleText && icons !== 1) findings.push('icon-only button has ' + icons + ' icons')
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
    // Charter Markdown is authored knowledge, not Cockpit chrome. It must stay
    // exactly as written even when it happens to contain a catalogued UI word.
    if (parent.closest('.wk-doc')) continue
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
  const localAssetsFlag = process.argv.indexOf('--local-assets')
  const localAssets = localAssetsFlag >= 0 ? process.argv[localAssetsFlag + 1] : undefined
  const screenshotsFlag = process.argv.indexOf('--screenshots')
  const screenshots = screenshotsFlag >= 0 ? process.argv[screenshotsFlag + 1] : undefined
  if (locale !== undefined && locale !== 'en' && locale !== 'de') {
    console.error('✗ --locale must be en or de')
    process.exit(2)
  }
  if (screenshotsFlag >= 0 && !screenshots) {
    console.error('✗ --screenshots needs an output directory')
    process.exit(2)
  }
  const screenshotDirectory = screenshots ? resolve(screenshots) : undefined
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true })

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
      if (localAssets) await serveLocalCockpit(context, base, localAssets)
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
        // Some cockpit routes keep a live request open. `networkidle` would turn
        // that healthy behaviour into a false timeout, so wait for the document
        // and then for loaded styles, the application shell and settled table
        // reads that the layout probe actually needs.
        await page.goto(url.href, { waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('load')
        await page.locator('[data-testid="sidebar-trigger"]').waitFor({ state: 'attached', timeout: 15_000 })
        const tablesSettled = `() =>
          [...document.querySelectorAll('table')].every((table) => table.getAttribute('aria-busy') !== 'true') &&
          !document.querySelector('.animate-pulse, [data-testid="row-skeleton"]')`
        // Capability reads can mount an installation-only table after the
        // route shell itself appears. Give those child reads a full frame
        // window before declaring that the page has no table to wait for.
        await page.waitForTimeout(1_000)
        await page.waitForFunction(tablesSettled, undefined, { timeout: 15_000 })
        // Some installation-only tables mount after their parent capability
        // read settles. Hold the condition across one paint window so a late
        // skeleton cannot be mistaken for clipped production data.
        await page.waitForTimeout(250)
        await page.waitForFunction(tablesSettled, undefined, { timeout: 15_000 })

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

        // The compact operator flow is a browser contract, not only a source
        // convention. These checks exercise the real controls in addition to
        // measuring the resulting layout.
        if (route === '/') {
          if ((await page.locator('[data-testid="home-search"]').count()) !== 1)
            findings.push({ route, viewport: viewport.name, what: 'the global home search is missing' })
          for (const retired of ['home-knowledge', 'home-recent', 'home-global']) {
            if ((await page.locator(`[data-testid="${retired}"]`).count()) > 0)
              findings.push({
                route,
                viewport: viewport.name,
                what: `retired home section is still rendered: ${retired}`,
              })
          }
        }
        if (route === '/spaces' && (await page.locator('[data-testid="spaces-show-tests"]').count()) > 0) {
          findings.push({ route, viewport: viewport.name, what: 'the retired test-wiki filter is still rendered' })
        }
        if (route === '/search') {
          const all = page.locator('[data-testid="search-scope-choice-all"]')
          const wiki = page.locator('[data-testid="search-scope-choice-wiki"]')
          if ((await all.getAttribute('data-state')) !== 'on')
            findings.push({ route, viewport: viewport.name, what: 'global search is not the default scope' })
          if ((await page.locator('[data-testid="search-ask"]').count()) > 0)
            findings.push({ route, viewport: viewport.name, what: 'Q&A is visible in the global search scope' })
          await wiki.click()
          const ask = page.locator('[data-testid="search-ask"]')
          const opened = await ask
            .waitFor({ state: 'visible', timeout: 5_000 })
            .then(() => true)
            .catch(() => false)
          if (!opened)
            findings.push({
              route,
              viewport: viewport.name,
              what: 'Q&A did not appear after choosing the current wiki',
            })
          await all.click()
          const closed = await ask
            .waitFor({ state: 'detached', timeout: 5_000 })
            .then(() => true)
            .catch(() => false)
          if (!closed)
            findings.push({ route, viewport: viewport.name, what: 'Q&A stayed visible after returning to all wikis' })
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
        if (screenshotDirectory) {
          const routeName = route === '/' ? 'home' : route.slice(1).replaceAll('/', '-')
          await page.screenshot({
            path: join(screenshotDirectory, `${locale ?? 'auto'}-${viewport.name}-${routeName}.png`),
            fullPage: false,
          })
        }
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }

  console.log(`› checked ${checked} route/viewport pairs against ${base}${space ? ` in ${space}` : ''}`)
  if (screenshotDirectory) console.log(`› screenshots: ${screenshotDirectory}`)
  if (!findings.length) {
    console.log(`\x1b[32m✓ no layout${locale === 'de' ? ' or German localisation' : ''} findings\x1b[0m`)
    // Said out loud rather than left implied: a green run means these three
    // assertions held, not that the console is correct.
    console.log('  (layout, table containment, cell clipping, selectors and icon ownership)')
    return
  }
  for (const finding of findings) {
    console.error(`\x1b[31m✗\x1b[0m ${finding.viewport} ${finding.route}: ${finding.what}`)
  }
  process.exit(1)
}

/**
 * Exercise an unshipped Cockpit bundle against the deployment's real API.
 *
 * The page keeps the deployment origin, session cookie and data. Only requests
 * below `/cockpit/` are fulfilled from the generated local bundle. That closes
 * the release-testing gap where a data-dependent layout fix could otherwise be
 * checked only after publishing another release.
 */
async function serveLocalCockpit(
  context: import('playwright').BrowserContext,
  base: string,
  directory: string,
): Promise<void> {
  const root = resolve(directory)
  await context.route(`${base.replace(/\/$/, '')}/cockpit/**`, async (route) => {
    const url = new URL(route.request().url())
    const suffix = decodeURIComponent(url.pathname.replace(/^\/cockpit\/?/, ''))
    const requested = suffix.startsWith('assets/') ? suffix : 'index.html'
    const file = resolve(root, requested)
    const inside = relative(root, file)
    if (inside === '..' || inside.startsWith(`..${sep}`)) {
      await route.abort('blockedbyclient')
      return
    }
    try {
      await route.fulfill({ body: await readFile(file), contentType: contentType(file) })
    } catch {
      await route.fulfill({ status: 404, body: 'Not found', contentType: 'text/plain' })
    }
  })
}

function contentType(file: string): string {
  if (extname(file) === '.html') return 'text/html; charset=utf-8'
  if (extname(file) === '.css') return 'text/css; charset=utf-8'
  if (extname(file) === '.js') return 'text/javascript; charset=utf-8'
  return 'application/octet-stream'
}

await main()
