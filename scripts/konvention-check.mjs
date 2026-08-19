// The family convention, asserted against this repository's own cockpit.
//
// WHY this exists next to check-cockpit-browser.ts: that script measures LAYOUT
// in a real browser against a real installation — it needs a database, a server
// and a key, and it answers "does this render without breaking". This one
// answers a different question: "does this console still say what the six
// products agreed to say". The rules live in COCKPIT-KONVENTION.md; a document
// nobody executes drifts silently, and drift in six repositories at once is
// exactly what §7 warns about.
//
// It runs with NO database and NO backend. Every /v1 read is fulfilled from the
// fixtures below through Playwright's page.route, and the pages are served by
// this repository's own Vite dev server, which the script starts and stops for
// itself. That is deliberate: a conformance check that needs a live stack is a
// check people run once and then stop running, and its verdict would depend on
// whatever happened to be in somebody's database that morning.
//
//   bun scripts/konvention-check.mjs
//   COCKPIT_BASE_URL=http://127.0.0.1:4061 bun scripts/konvention-check.mjs
//
// Deliberately NOT wired into `bun run gate`, `bun test` or CI. The convention
// is a target the console is being moved towards, not a promise it already
// keeps — see §7: "Die Konvention wird nicht technisch erzwungen." A red run
// here is a worklist, not a broken build.
//
// Every violation is collected, never thrown at: one run must produce the whole
// list, because fixing them one rebuild at a time is how a checklist of nine
// rules turns into nine mornings.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BASE = (process.env.COCKPIT_BASE_URL ?? '').replace(/\/$/, '')
const PORT = Number(process.env.COCKPIT_CHECK_PORT ?? 4173)
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VITE_CONFIG = 'apps/cockpit/vite.config.ts'

// The wiki the fixtures describe. A slug rather than an id everywhere it is
// visible, because §5 forbids raw identifiers on screen and a fixture that
// smuggles one in would be testing itself rather than the console.
const SPACE = { id: '11111111-1111-4111-8111-000000000001', slug: 'handbuch', name: 'Handbuch' }

// Stamped against the run, not frozen. The decisions page sorts the "waiting
// longer" rubric by comparing each item against `generated_at`, so a fixed
// instant would eventually push every item into the aged rubric and the
// non-aged branch would stop being exercised at all.
const NOW = Date.now()
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString()

/** Five open proposals: two older than three days (§8.2's rubric), three fresh. */
const OPEN_ITEMS = [
  {
    key: 'proposal:11111111-1111-4111-8111-000000000011',
    title: 'Rückgaberecht: Fristen aus dem Support-Handbuch übernehmen',
    summary: 'Zwei Absätze zur 14-Tage-Frist, belegt durch das Support-Handbuch.',
    ageDays: 9,
  },
  {
    key: 'proposal:11111111-1111-4111-8111-000000000012',
    title: 'Eskalationsweg für Zahlungsausfälle beschreiben',
    summary: 'Neue Seite mit dem Weg von der ersten Mahnung bis zur Sperrung.',
    ageDays: 5,
  },
  {
    key: 'proposal:11111111-1111-4111-8111-000000000013',
    title: 'Begriff „Freigabe" gegen die Leitlinien schärfen',
    summary: 'Ersetzt eine mehrdeutige Formulierung auf der Freigabe-Seite.',
    ageDays: 2,
  },
  {
    key: 'proposal:11111111-1111-4111-8111-000000000014',
    title: 'Kontaktwege im Onboarding aktualisieren',
    summary: 'Die alte Telefonnummer steht noch auf zwei Seiten.',
    ageDays: 1,
  },
  {
    key: 'proposal:11111111-1111-4111-8111-000000000015',
    title: 'Urlaubsantrag: Vertretungsregel ergänzen',
    summary: 'Ein Absatz zur Vertretung, belegt durch die Betriebsvereinbarung.',
    ageDays: 0,
  },
]

function attentionItem(item) {
  return {
    key: item.key,
    kind: 'proposal',
    state: 'open',
    title: item.title,
    summary: item.summary,
    effect: 'Das Wiki ändert sich erst nach einer Freigabe.',
    created_at: daysAgo(item.ageDays),
    remind_at: null,
    note: null,
    origins: [
      { kind: 'source', label: 'Support-Handbuch 2026', href: '/sources/support-handbuch', provenance: 'external' },
    ],
    targets: [{ kind: 'page', label: 'Rückgaberecht', href: '/pages/rueckgaberecht', change: 'update' }],
    available_actions: ['approve', 'reject', 'request_changes'],
    previous_rejection: null,
  }
}

/**
 * Two worlds, because §8.7 is a rule with two halves: a banner when a gate is
 * open, and NO banner when none is. Checking only the loud half would let a
 * console that always shouts pass.
 */
const WORLDS = {
  'gate-open': {
    items: OPEN_ITEMS.map(attentionItem),
    counts: {
      open: OPEN_ITEMS.length,
      overdue: 1,
      oldest_days: 9,
      by_kind: { proposal: OPEN_ITEMS.length, triage: 0 },
    },
  },
  'gate-clear': {
    items: [],
    counts: { open: 0, overdue: 0, oldest_days: null, by_kind: { proposal: 0, triage: 0 } },
  },
}

/**
 * One handler for every /v1 read, dispatching on the pathname.
 *
 * Unmatched paths answer an empty list rather than a failure, and are collected
 * so the run can say which reads it did not model. A 404 here would paint the
 * page with error alerts that the banner and empty-state assertions would then
 * be measuring instead of the product.
 */
function mockApi(world, unmocked) {
  const state = WORLDS[world]
  return async (route) => {
    const path = new URL(route.request().url()).pathname
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

    if (path === '/v1/session') {
      return json({
        session: {
          name: 'mike@mikebild.com',
          kind: 'identity',
          scopes: ['admin', 'knowledge:read', 'knowledge:approve'],
          space_id: null,
          provider_id: 'local',
        },
      })
    }
    if (path === '/v1/spaces') {
      return json({
        items: [
          {
            ...SPACE,
            settings: {},
            epoch: 1,
            created_at: daysAgo(300),
            updated_at: daysAgo(1),
          },
        ],
      })
    }
    if (path === '/v1/attention') {
      return json({
        generated_at: new Date(NOW).toISOString(),
        counts: { open: state.counts.open, oldest_days: state.counts.oldest_days, by_kind: state.counts.by_kind },
        items: state.items.map((item) => ({
          space: SPACE.slug,
          space_name: SPACE.name,
          key: item.key,
          kind: item.kind,
          title: item.title,
          summary: item.summary,
          created_at: item.created_at,
          available_actions: item.available_actions,
        })),
        next_cursor: null,
      })
    }
    if (path === `/v1/spaces/${SPACE.slug}/attention`) {
      return json({ generated_at: new Date(NOW).toISOString(), counts: state.counts, items: state.items })
    }

    unmocked.add(path)
    return json({ items: [], next_cursor: null })
  }
}

// Browser code lives in strings for the same reason as in
// check-cockpit-browser.ts: this repository's lint config gives .mjs files node
// globals only, on purpose, so a script that reaches for `document` outside an
// evaluated probe is a mistake the linter should catch rather than allow.
const SHELL_PROBE = `(() => {
  const text = (element) => (element ? (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim() : null)
  const nav = document.querySelector('nav[aria-label]')
  const links = nav ? [...nav.querySelectorAll('a[data-testid^="nav-"]')] : []
  const groupOf = (element) => {
    const group = element ? element.closest('[data-testid^="nav-group-"]') : null
    return group ? group.getAttribute('data-testid') : null
  }
  const installation = document.querySelector('[data-testid="nav-group-installation"]')
  const installationLabel = installation
    ? text(installation.querySelector('[data-testid$="-toggle"], [data-sidebar="group-label"]'))
    : null
  const badge = document.querySelector('[data-testid="nav-decisions-count"]')
  const decisions = document.querySelector('[data-testid="nav-decisions"]')
  return {
    order: links.map((link) => link.getAttribute('data-testid')),
    homeGroup: groupOf(document.querySelector('[data-testid="nav-home"]')),
    decisionsGroup: groupOf(decisions),
    decisionsLabel: text(decisions),
    installationPresent: Boolean(installation),
    installationLabel: installationLabel,
    badge: badge ? text(badge) : null,
    role: text(document.querySelector('[data-testid="operator-scopes"]')),
    account: text(document.querySelector('[data-testid="account-menu-trigger"]')),
  }
})()`

const SURFACE_PROBE = `(() => {
  const shown = (element) => {
    if (!element) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    return element.getClientRects().length > 0
  }
  const texts = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') continue
    if (!shown(parent)) continue
    const value = (node.textContent || '').replace(/\\s+/g, ' ').trim()
    if (value) texts.push(value)
  }
  const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
    .filter(shown)
    .map((element) => (element.value || element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter(Boolean)
  return { texts: texts, buttons: buttons }
})()`

// §8.7 is an ORDER claim, not merely a presence claim: the banner stands above
// everything else on the overview. So the probe reports where the first content
// block is, and whether the banner precedes it — a banner rendered under the
// tiles is a banner an operator scrolls past.
const BANNER_PROBE = `(() => {
  const page = document.querySelector('[data-testid="page"]')
  if (!page) return { page: false }
  const banner = page.querySelector('[data-testid="incident-banner"]') || page.querySelector('[role="alert"]')
  const blocks = [...page.querySelectorAll('section, form, table, [data-slot="card"], [data-testid$="-tile"]')]
  const first = blocks.find((block) => !banner || !(banner.contains(block) || block.contains(banner))) || null
  const links = banner ? [...banner.querySelectorAll('a[href]')] : []
  return {
    page: true,
    banner: Boolean(banner),
    testId: banner ? banner.getAttribute('data-testid') : null,
    text: banner ? (banner.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
    firstBlock: first ? first.getAttribute('data-testid') || first.tagName.toLowerCase() : null,
    beforeBlocks: Boolean(
      banner && first && (banner.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ),
    links: links.map((link) => link.getAttribute('href')),
  }
})()`

const QUEUE_PROBE = `(() => {
  const list = document.querySelector('[data-testid="attention-list"]')
  if (!list) return { list: false, cards: 0, headings: [] }
  const cards = [...list.querySelectorAll('[data-testid^="decision-item-"], [data-testid^="decision-waiting-"]')]
    .map((card) => card.getAttribute('data-testid'))
    .filter((id) => /^decision-(item|waiting)-\\d+$/.test(id))
  const headings = [...list.querySelectorAll('h1, h2, h3, h4')]
    .map((heading) => (heading.innerText || heading.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter(Boolean)
  return { list: true, cards: cards.length, headings: headings }
})()`

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/i
const FORBIDDEN_BUTTONS = ['ok', 'submit']

async function main() {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    console.error('✗ playwright is not installed. `bun add -d playwright && bunx playwright install chromium`')
    process.exit(2)
  }

  const server = BASE ? null : await startCockpit()
  const base = BASE || `http://127.0.0.1:${PORT}`
  const violations = []
  const unmocked = new Set()
  const note = (rule, where, actual) => violations.push({ rule, where, actual })

  const browser = await chromium.launch()
  try {
    // German, because the convention IS a German-language contract: §5 names
    // "Administrator", §6 names "Installation", §8.2 names "Liegt schon
    // länger". Checking the English surface would check a different product.
    const context = await browser.newContext({ locale: 'de-DE', viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(() => {
      localStorage.setItem('wikikit-cockpit-locale', 'de')
      localStorage.setItem('wk-cockpit-space', 'handbuch')
      localStorage.setItem('wikikit-cockpit-theme', 'light')
    })

    const openWorld = mockApi('gate-open', unmocked)
    const clearWorld = mockApi('gate-clear', unmocked)

    const page = await context.newPage()
    page.on('pageerror', (error) => note('§0', 'browser', `uncaught error: ${error.message}`))
    await page.route('**/v1/**', (route) => openWorld(route))

    // ---- Overview, with a gate open --------------------------------------
    await open(page, `${base}/cockpit/`)
    const shell = await page.evaluate(SHELL_PROBE)
    const overview = await page.evaluate(SURFACE_PROBE)
    const banner = await page.evaluate(BANNER_PROBE)

    // §5/§6 — one spelling of the role, and it is "Administrator".
    if (shell.role !== 'Administrator') {
      note('§5/§6', 'Sidebar › Account-Block [data-testid="operator-scopes"]', `„${shell.role ?? '(fehlt)'}"`)
    }
    for (const word of (shell.account ?? '').split(/\s+/)) {
      if (/^admin(istrator)?$/i.test(word) && word !== 'Administrator') {
        note('§6', 'Sidebar › Account-Block', `Rollen-Variante „${word}" statt „Administrator"`)
      }
    }

    // §6 — the admin group is called "Installation", never "Administration".
    if (!shell.installationPresent) {
      note('§6', 'Sidebar › Admin-Gruppe', 'keine Nav-Gruppe „installation" im DOM')
    } else if (shell.installationLabel !== 'Installation') {
      note('§6', 'Sidebar › Admin-Gruppe', `„${shell.installationLabel ?? '(kein Label)'}"`)
    }

    // §8.1 — the decisions entry is ungrouped, sits directly under the
    // overview, and carries a live counter.
    if (shell.decisionsLabel !== 'Entscheidungen') {
      note('§8.1', 'Sidebar › Entscheidungs-Eintrag', `„${shell.decisionsLabel ?? '(fehlt)'}"`)
    }
    if (shell.decisionsGroup !== shell.homeGroup) {
      note(
        '§8.1',
        'Sidebar › Entscheidungs-Eintrag',
        `gruppiert unter „${shell.decisionsGroup ?? '(keine Gruppe)'}", Übersicht steht in „${shell.homeGroup ?? '(keine Gruppe)'}"`,
      )
    }
    const homeIndex = shell.order.indexOf('nav-home')
    const decisionsIndex = shell.order.indexOf('nav-decisions')
    if (decisionsIndex !== homeIndex + 1) {
      note('§8.1', 'Sidebar › Reihenfolge', `${shell.order.join(' → ')}`)
    }
    if (shell.badge === null) {
      note('§8.1', 'Sidebar › Entscheidungs-Eintrag', 'kein Zähler-Badge [data-testid="nav-decisions-count"]')
    }

    // §8.7 — the overview shouts when a gate is open, above everything else,
    // with exactly one link and that link goes to the decisions page.
    if (!banner.page) {
      note('§8.7', 'Übersicht', 'kein [data-testid="page"] — die Seite hat nicht gemountet')
    } else if (!banner.banner) {
      note('§8.7', 'Übersicht (Fixture „gate-open", 5 offene Gates)', 'kein Incident-Banner im DOM')
    } else {
      if (!banner.beforeBlocks) {
        note('§8.7', 'Übersicht › Incident-Banner', `steht hinter „${banner.firstBlock ?? '(nichts)'}"`)
      }
      if (banner.links.length !== 1) {
        note('§8.7', 'Übersicht › Incident-Banner', `${banner.links.length} Links: ${banner.links.join(', ') || '—'}`)
      } else if (!/\/decisions(\/|$|\?)/.test(banner.links[0] ?? '')) {
        note('§8.7', 'Übersicht › Incident-Banner', `Link zeigt auf „${banner.links[0]}" statt auf /decisions`)
      }
    }
    collectSurface(note, 'Übersicht', overview)

    // ---- Decisions queue, same world -------------------------------------
    await open(page, `${base}/cockpit/decisions?space=${SPACE.slug}`)
    const queueShell = await page.evaluate(SHELL_PROBE)
    const queue = await page.evaluate(QUEUE_PROBE)
    const decisionsSurface = await page.evaluate(SURFACE_PROBE)

    if (!queue.list) {
      note('§8.2', 'Entscheidungs-Seite', 'keine Queue [data-testid="attention-list"] im DOM')
    } else if (!queue.headings.includes('Liegt schon länger')) {
      note(
        '§8.2',
        'Entscheidungs-Queue › Aging-Rubrik',
        `Überschriften: ${queue.headings.map((heading) => `„${heading}"`).join(', ') || '(keine)'}`,
      )
    }
    collectSurface(note, 'Entscheidungen', decisionsSurface)

    // Number coherence: the sidebar counter and the queue count the same thing,
    // and a console that disagrees with itself teaches an operator to trust
    // neither number. §1: "Kein Zähler ohne Link" has a silent partner — no
    // counter without a matching list.
    const badgeCount = Number.parseInt(queueShell.badge ?? '', 10)
    if (!Number.isFinite(badgeCount)) {
      note('§8.1/§1', 'Sidebar-Badge vs. Queue', `Badge liest „${queueShell.badge ?? '(fehlt)'}"`)
    } else if (badgeCount !== queue.cards) {
      note('§8.1/§1', 'Sidebar-Badge vs. Queue', `Badge ${badgeCount}, Queue ${queue.cards} Positionen`)
    }

    // ---- Overview again, with nothing open -------------------------------
    await page.unroute('**/v1/**')
    await page.route('**/v1/**', (route) => clearWorld(route))
    await open(page, `${base}/cockpit/`)
    const quiet = await page.evaluate(BANNER_PROBE)
    if (quiet.banner) {
      note('§8.7', 'Übersicht (Fixture „gate-clear", 0 offene Gates)', `Banner trotzdem sichtbar: „${quiet.text}"`)
    }

    await context.close()
  } finally {
    await browser.close()
    if (server) await stopCockpit(server)
  }

  report(base, violations, unmocked)
}

/** The two DOM-wide prohibitions, applied to whatever page was just measured. */
function collectSurface(note, where, surface) {
  for (const text of surface.texts) {
    if (/\bUnbekannt\b/.test(text)) note('§2', `${where} › sichtbarer Text`, `„${text.slice(0, 80)}"`)
    if (UUID.test(text)) note('§5/§8.3', `${where} › sichtbarer Text`, `„${text.slice(0, 80)}"`)
  }
  for (const label of surface.buttons) {
    if (FORBIDDEN_BUTTONS.includes(label.toLowerCase())) {
      note('§8.3', `${where} › Button`, `beschriftet „${label}"`)
    }
  }
}

/** Wait for the shell, not for the network: mocked reads settle in one tick. */
async function open(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="sidebar-trigger"]').waitFor({ state: 'attached', timeout: 15_000 })
  await page.locator('[data-testid="page"]').waitFor({ state: 'attached', timeout: 15_000 })
  // Skeletons resolve within §4's five seconds; a shorter settle window here
  // would measure a loading state and call it the product.
  await page.waitForTimeout(750)
}

/**
 * The dev server, started for this run and killed with it.
 *
 * Vite serves the console straight from source, so the check needs no build
 * artefact and cannot go stale against one. The port is not 4061 on purpose:
 * running this must never fight with a dev server somebody has open.
 */
async function startCockpit() {
  const child = spawn(
    'bunx',
    ['vite', '--config', VITE_CONFIG, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (chunk) => log.push(String(chunk)))
  child.stderr.on('data', (chunk) => log.push(String(chunk)))

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(`✗ the cockpit dev server exited with ${child.exitCode}\n${log.join('')}`)
      process.exit(2)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/cockpit/`)
      if (response.ok) return child
    } catch {
      // Not listening yet. The deadline, not this catch, decides when to give up.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  child.kill('SIGTERM')
  console.error(`✗ the cockpit dev server did not answer on ${PORT} within 60s\n${log.join('')}`)
  process.exit(2)
}

async function stopCockpit(child) {
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    child.once('exit', resolve)
    setTimeout(resolve, 5_000)
  })
}

function report(base, violations, unmocked) {
  console.log(`› checked the cockpit at ${base} against COCKPIT-KONVENTION.md v1.4 (fixtures, no database)`)
  if (unmocked.size) {
    console.log(`› reads answered with an empty list because no fixture models them: ${[...unmocked].join(', ')}`)
  }
  if (!violations.length) {
    console.log('\x1b[32m✓ no convention violations\x1b[0m')
    // Said out loud rather than left implied: green means these nine rules
    // held against these fixtures, not that the console is conformant.
    console.log('  (Rollen-Label, Installation-Gruppe, Entscheidungs-Eintrag, Zustandswort, Incident-Banner,')
    console.log('   Aging-Rubrik, Button-Beschriftung, UUID-Freiheit, Zahl-Kohärenz)')
    return
  }
  for (const violation of violations) {
    console.error(`\x1b[31m✗\x1b[0m ${violation.rule} · ${violation.where} · ${violation.actual}`)
  }
  console.error(`\n${violations.length} Verstöße gegen COCKPIT-KONVENTION.md v1.4`)
  process.exit(1)
}

await main()
