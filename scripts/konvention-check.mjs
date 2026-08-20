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

// The wikis the fixtures describe. Slugs rather than ids everywhere they are
// visible, because §5 forbids raw identifiers on screen and a fixture that
// smuggled one in would be testing itself rather than the console.
//
// TWO of them, and that is load-bearing: the open queue is installation-wide
// (§8.1) and its wiki chips filter rows without touching the counters, and
// neither claim can be checked against a fixture with one wiki in it — the chip
// would have nothing to filter away.
// The canonical spelling, in ONE place in this script, because the asserts
// below compare against it character by character and two literals drift.
const PRODUCT_NAME = 'WikiKit'

const SPACES = [
  { id: '11111111-1111-4111-8111-000000000001', slug: 'handbuch', name: 'Handbuch' },
  { id: '11111111-1111-4111-8111-000000000002', slug: 'onboarding', name: 'Onboarding' },
]
const SPACE = SPACES[0]

// Stamped against the run, not frozen. The decisions page sorts the "waiting
// longer" rubric by comparing each item against `generated_at`, so a fixed
// instant would eventually push every item into the aged rubric and the
// non-aged branch would stop being exercised at all.
const NOW = Date.now()
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString()

/**
 * Five open proposals: two older than three days (§8.2's rubric), three fresh,
 * and one of them in a second wiki.
 *
 * Two aged out of five is a REAL subset on purpose. A fixture where every open
 * position is also an aged one would let a banner that simply prints the total
 * pass the "N von M" sentence, and the sentence is the whole point: it says how
 * much of the queue has gone stale, not how big the queue is.
 */
const OPEN_ITEMS = [
  {
    space: 'handbuch',
    key: 'proposal:11111111-1111-4111-8111-000000000011',
    title: 'Rückgaberecht: Fristen aus dem Support-Handbuch übernehmen',
    summary: 'Zwei Absätze zur 14-Tage-Frist, belegt durch das Support-Handbuch.',
    ageDays: 9,
  },
  {
    space: 'handbuch',
    key: 'proposal:11111111-1111-4111-8111-000000000012',
    title: 'Eskalationsweg für Zahlungsausfälle beschreiben',
    summary: 'Neue Seite mit dem Weg von der ersten Mahnung bis zur Sperrung.',
    ageDays: 5,
  },
  {
    space: 'handbuch',
    key: 'proposal:11111111-1111-4111-8111-000000000013',
    title: 'Begriff „Freigabe" gegen die Leitlinien schärfen',
    summary: 'Ersetzt eine mehrdeutige Formulierung auf der Freigabe-Seite.',
    ageDays: 2,
  },
  {
    space: 'handbuch',
    key: 'proposal:11111111-1111-4111-8111-000000000014',
    title: 'Kontaktwege im Onboarding aktualisieren',
    summary: 'Die alte Telefonnummer steht noch auf zwei Seiten.',
    ageDays: 1,
  },
  {
    space: 'onboarding',
    key: 'proposal:11111111-1111-4111-8111-000000000015',
    title: 'Urlaubsantrag: Vertretungsregel ergänzen',
    summary: 'Ein Absatz zur Vertretung, belegt durch die Betriebsvereinbarung.',
    ageDays: 0,
  },
  // Written the way the SERVER writes one, verbatim: the proposal title is
  // composed from whatever the source was called, and an ingested coding
  // session is called "Codex session <id>". Without a row like this the UUID
  // prohibition below would only ever run over titles a human wrote, and would
  // have passed on the day this console was shipping identifiers to readers.
  {
    space: 'handbuch',
    key: 'proposal:11111111-1111-4111-8111-000000000016',
    title: 'Ingest: Codex session 01a0103d-9c1f-4a6e-9e2f-2b71c0a5d4e8',
    summary:
      'Synthesized 8 concepts, 28 claims, 2 contradictions detected from source 8e065dc7-4b1a-4c33-9a77-1f0c1d3e5b62.',
    ageDays: 4,
  },
]

/** How many of them §8.2 calls old, and how old the oldest is. */
const AGED_ITEMS = OPEN_ITEMS.filter((item) => item.ageDays >= 3).length
const OLDEST_DAYS = Math.max(...OPEN_ITEMS.map((item) => item.ageDays))

function attentionItem(item) {
  return {
    space: item.space,
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
      oldest_days: OLDEST_DAYS,
      by_kind: { proposal: OPEN_ITEMS.length, triage: 0 },
    },
  },
  'gate-clear': {
    items: [],
    counts: { open: 0, overdue: 0, oldest_days: null, by_kind: { proposal: 0, triage: 0 } },
  },
}

/**
 * The global feed, WITH one position delivered twice.
 *
 * A retry, a cursor overlap, two synthesis runs on one source — a feed repeats
 * itself in production, and a console that counts rows would report six open
 * decisions where five exist. `counts.open` stays 5, so the duplicate is only
 * survivable if the console deduplicates by wiki AND key before it counts and
 * before it decides whether its list is short of the count.
 */
function globalItems(items) {
  const rows = items.map((item) => ({
    space: item.space,
    space_name: SPACES.find((space) => space.slug === item.space)?.name ?? item.space,
    key: item.key,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    created_at: item.created_at,
    available_actions: item.available_actions,
  }))
  return rows.length ? [...rows, rows[0]] : rows
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
        items: SPACES.map((space) => ({
          ...space,
          settings: {},
          epoch: 1,
          created_at: daysAgo(300),
          updated_at: daysAgo(1),
        })),
      })
    }
    if (path === '/v1/attention') {
      return json({
        generated_at: new Date(NOW).toISOString(),
        counts: { open: state.counts.open, oldest_days: state.counts.oldest_days, by_kind: state.counts.by_kind },
        items: globalItems(state.items),
        next_cursor: null,
      })
    }
    const perSpace = SPACES.find((space) => path === `/v1/spaces/${space.slug}/attention`)
    if (perSpace) {
      // The shelves and the expanded row read THIS, and it holds one wiki's
      // share — which is exactly the number the queue must NOT show any more.
      const items = state.items.filter((item) => item.space === perSpace.slug)
      const oldest = items.length
        ? Math.max(...items.map((item) => Math.floor((NOW - Date.parse(item.created_at)) / 86_400_000)))
        : null
      return json({
        generated_at: new Date(NOW).toISOString(),
        counts: {
          open: items.length,
          overdue: items.length ? state.counts.overdue : 0,
          oldest_days: oldest,
          by_kind: { proposal: items.length, triage: 0 },
        },
        items,
      })
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
  const wordmark = document.querySelector('[data-testid="cockpit-wordmark"]')
  return {
    wordmark: wordmark ? { name: text(wordmark) } : null,
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
  if (!list) return { list: false, cards: 0, headings: [], keys: [], chips: [] }
  const cards = [...list.querySelectorAll('[data-testid^="decision-item-"], [data-testid^="decision-waiting-"]')]
    .map((card) => card.getAttribute('data-testid'))
    .filter((id) => /^decision-(item|waiting)-\\d+$/.test(id))
  const headings = [...list.querySelectorAll('h1, h2, h3, h4')]
    .map((heading) => (heading.innerText || heading.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter(Boolean)
  const number = (value) => (value === null || value === '' ? null : Number(value))
  return {
    list: true,
    cards: cards.length,
    headings: headings,
    total: number(list.getAttribute('data-total')),
    capped: list.getAttribute('data-capped'),
    keys: [...list.querySelectorAll('[data-decision-key]')].map(
      (card) => card.getAttribute('data-space') + ':' + card.getAttribute('data-decision-key'),
    ),
    chips: [...document.querySelectorAll('[data-testid^="decisions-space-"]')].map((chip) =>
      chip.getAttribute('data-testid'),
    ),
  }
})()`

// The four places the console prints the number of open decisions. Read from
// ONE probe so the comparison is of one instant rather than of four.
const NUMBERS_PROBE = `(() => {
  const number = (element, attribute) => {
    if (!element) return null
    const raw = attribute ? element.getAttribute(attribute) : element.innerText || element.textContent || ''
    const value = Number(String(raw).trim())
    return Number.isFinite(value) ? value : null
  }
  const banner = document.querySelector('[data-testid="incident-decisions-count"]')
  return {
    nav: number(document.querySelector('[data-testid="nav-decisions-count"]')),
    zoneA: number(document.querySelector('[data-testid="zone-a-decisions-count"]'), 'data-total'),
    bannerTotal: number(banner, 'data-subset-total'),
    bannerCount: number(banner, 'data-subset-count'),
    bannerSubset: banner ? banner.getAttribute('data-subset') : null,
    bannerText: banner ? (banner.innerText || banner.textContent || '').replace(/\\s+/g, ' ').trim() : null,
  }
})()`

// §1's Zone A, read as an ANATOMY rather than as a presence: the card is only
// worth having if the count and the age are in its head, where a reader meets
// them before the rows, and if every row leads somewhere. A card with the
// numbers buried three rows down is the table it replaced.
const ZONE_A_PROBE = `(() => {
  const clean = (element) => (element ? (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim() : null)
  const card = document.querySelector('[data-testid="zone-a"]')
  if (!card) return { card: false }
  const head = card.querySelector('[data-slot="card-header"]')
  const count = head ? head.querySelector('[data-testid="zone-a-decisions-count"]') : null
  const rows = [...card.querySelectorAll('[data-testid]')].filter((element) =>
    /^home-task-\\d+$/.test(element.getAttribute('data-testid')),
  )
  return {
    card: true,
    heading: clean(card.querySelector('[data-slot="card-title"]')),
    countInHead: Boolean(count),
    countHref: count ? count.getAttribute('href') : null,
    head: clean(head),
    rows: rows.length,
    linkedRows: rows.filter((row) => row.querySelector('a[href]')).length,
  }
})()`

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/i
const FORBIDDEN_BUTTONS = ['ok', 'submit']

/*
  §5 — German on the top level, English only in the depth.

  These are the pipeline's own words, not a translator's oversight: the ingest
  job composes "Synthesized 8 concepts, 28 claims … from source <id>." and
  stores it on the proposal, so it reaches the queue in English on a surface
  that is German everywhere else. The check runs in a de-DE context, so any of
  these on the visible surface is passthrough rather than legitimate English.
*/
const ENGLISH_PASSTHROUGH = [/\bSynthesized \d+ concepts?\b/i, /\bfrom source\b/i, /\b\d+ claims?\b/i]

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
    const numbers = await page.evaluate(NUMBERS_PROBE)
    const zoneA = await page.evaluate(ZONE_A_PROBE)

    // §5/§6 — the wordmark carries the canonical product name, and it comes
    // from the catalogue. Compared CHARACTER BY CHARACTER on purpose: a
    // case-insensitive test lets „WIKIKIT" pass as a hit, which is precisely
    // the state this assert was written to end.
    if (!shell.wordmark) {
      note('§5/§6', 'Sidebar › Wortmarke', 'kein [data-testid="cockpit-wordmark"] im DOM')
    } else {
      if (shell.wordmark.name !== PRODUCT_NAME) {
        note('§5/§6', 'Sidebar › Wortmarke', `„${shell.wordmark.name ?? '(leer)'}" statt „${PRODUCT_NAME}"`)
      }
      // A SECOND assert, and not a redundant one: the first catches today's
      // „WIKIKIT", this one catches a name that drifts to all-caps or
      // all-lowercase by some other route — a CSS `text-transform`, say, which
      // the first assert cannot see because it reads the DOM text.
      const name = shell.wordmark.name ?? ''
      if (name && (name === name.toUpperCase() || name === name.toLowerCase())) {
        note('§5/§6', 'Sidebar › Wortmarke', `„${name}" ist durchgehend groß- oder kleingeschrieben`)
      }
    }

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
    // §1 — Zone A is a CARD: the count and the age in the head, one action per
    // row, and it is the short form of the decisions page rather than a second
    // place to decide. The count is a link, because §1 has no counter without
    // one.
    if (!zoneA.card) {
      note('§1', 'Übersicht › Zone A', 'keine Karte [data-testid="zone-a"]')
    } else {
      if (zoneA.heading !== 'Wartet auf dich') {
        note('§1', 'Übersicht › Zone A › Überschrift', `„${zoneA.heading ?? '(keine)'}"`)
      }
      if (!zoneA.countInHead) {
        note('§1', 'Übersicht › Zone A › Kopf', 'kein Zähler [data-testid="zone-a-decisions-count"] im Kopf')
      } else if (!/\/decisions(\/|$|\?)/.test(zoneA.countHref ?? '')) {
        note('§1', 'Übersicht › Zone A › Zähler', `„${zoneA.countHref ?? '(kein Link)'}" statt /decisions`)
      }
      // "Alter der ältesten Position" — either a measured age or the sentence
      // that says there is none. A head with neither is a head that reports a
      // number without saying how long it has been true.
      if (!/älteste \d+ Tage|keine datierte Aufgabe/.test(zoneA.head ?? '')) {
        note('§1', 'Übersicht › Zone A › Kopf', `kein Alter der ältesten Position: „${zoneA.head ?? '(leer)'}"`)
      }
      if (zoneA.rows === 0) {
        note('§1', 'Übersicht › Zone A', 'keine Positionen in der Karte (Fixture „gate-open")')
      } else if (zoneA.linkedRows !== zoneA.rows) {
        note('§1', 'Übersicht › Zone A › Zeilen', `${zoneA.linkedRows} von ${zoneA.rows} Zeilen verlinkt`)
      }
    }

    collectSurface(note, 'Übersicht', overview)

    // §8.1/§8.7/§1 — the banner says how much of the queue has gone stale, and
    // it says it in a sentence rather than in a number an operator has to
    // interpret. The regex is the sentence's shape: "N von M", "Alle M" or
    // "mindestens N von M", always followed by the words §8.2 uses for the
    // same three days.
    const SENTENCE = /(?:mindestens \d+ von \d+|Alle \d+|\d+ von \d+) warten länger als drei Tage/
    if (numbers.bannerSubset === null) {
      note('§8.7', 'Übersicht › Incident-Banner', 'keine Zahl [data-testid="incident-decisions-count"]')
    } else {
      if (numbers.bannerSubset !== 'aging') {
        note(
          '§8.7',
          'Übersicht › Incident-Banner (Fixture: 2 von 5 älter als drei Tage)',
          `Teilmenge „${numbers.bannerSubset}" statt „aging"`,
        )
      } else if (!SENTENCE.test(numbers.bannerText ?? '')) {
        note('§8.7', 'Übersicht › Incident-Banner › Satz', `„${(numbers.bannerText ?? '').slice(0, 90)}"`)
      }
      // A subset is a SUBSET: at least one, and never more than the whole
      // queue. "0 von 5" is a banner about nothing and "7 von 5" is a banner
      // about a number nobody counted.
      if (!(numbers.bannerCount > 0 && numbers.bannerCount < numbers.bannerTotal)) {
        note(
          '§8.7',
          'Übersicht › Incident-Banner › Teilmenge',
          `${numbers.bannerCount} von ${numbers.bannerTotal} — keine echte Teilmenge`,
        )
      } else if (numbers.bannerCount !== AGED_ITEMS) {
        note(
          '§8.7',
          'Übersicht › Incident-Banner › Teilmenge',
          `${numbers.bannerCount} statt ${AGED_ITEMS} Positionen älter als drei Tage`,
        )
      }
    }

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

    /*
      Four surfaces, ONE number (§8.1/§1).

      The console prints how many decisions are open in four places: the sidebar
      badge, the Zone-A card, the incident banner and the queue. Before this
      check they printed three different numbers — 1, 1 and 3 — each of them
      correct about a different question, which is worse than one wrong number
      because nothing looks broken. So they are compared against each other
      rather than against a constant: a fixture number would only prove the
      fixture, and the failure this guards against is disagreement.
    */
    const badgeCount = Number.parseInt(queueShell.badge ?? '', 10)
    const four = [
      ['Nav-Badge', badgeCount],
      ['Zone-A-Karte', numbers.zoneA],
      ['Incident-Banner', numbers.bannerTotal],
      ['Queue', queue.total],
    ]
    const missing = four.filter(([, value]) => !Number.isFinite(value)).map(([name]) => name)
    if (missing.length) {
      note('§8.1/§1', 'Vier Zahlen', `ohne lesbare Zahl: ${missing.join(', ')}`)
    } else if (new Set(four.map(([, value]) => value)).size !== 1) {
      note('§8.1/§1', 'Vier Zahlen', four.map(([name, value]) => `${name} ${value}`).join(', '))
    }
    // The list is complete in this fixture, so it must not hedge — and the six
    // delivered rows must render as the five positions they are.
    if (queue.capped !== 'false') {
      note('§8.1', 'Entscheidungs-Queue', `data-capped="${queue.capped}" bei vollständiger Liste`)
    }
    if (new Set(queue.keys).size !== queue.keys.length) {
      note(
        '§8.2',
        'Entscheidungs-Queue › Dubletten',
        `${queue.keys.length} Zeilen, ${new Set(queue.keys).size} Positionen`,
      )
    }
    if (queue.keys.length !== queue.cards) {
      note('§8.2', 'Entscheidungs-Queue', `${queue.cards} Karten, aber ${queue.keys.length} mit data-decision-key`)
    }

    /*
      §10 — the wiki chips filter ROWS and nothing else.

      The fixture holds two wikis on purpose: with one, a chip has nothing to
      filter away and this assertion would pass without measuring anything. So
      the second wiki's chip is pressed, and the two numbers on this page must
      not move. A filter that also moves the counter answers "how many are
      open" with the answer to "how many are open in what I am looking at",
      under the same label.
    */
    const chip = `decisions-space-${SPACES[1].slug}`
    if (!queue.chips.includes(chip)) {
      note('§10', 'Entscheidungs-Queue › Wiki-Chips', `Chips: ${queue.chips.join(', ') || '(keine)'}`)
    } else {
      await page.locator(`[data-testid="${chip}"]`).click()
      await page.waitForTimeout(250)
      const filtered = await page.evaluate(QUEUE_PROBE)
      const filteredShell = await page.evaluate(SHELL_PROBE)
      if (filtered.total !== queue.total) {
        note('§10', 'Wiki-Chip vs. Gesamtzahl', `Queue ${queue.total} → ${filtered.total} nach Chip-Klick`)
      }
      if (filteredShell.badge !== queueShell.badge) {
        note('§10', 'Wiki-Chip vs. Nav-Badge', `Badge „${queueShell.badge}" → „${filteredShell.badge}"`)
      }
      if (filtered.cards >= queue.cards) {
        note('§10', 'Wiki-Chip', `filtert keine Zeilen weg: ${queue.cards} → ${filtered.cards}`)
      }
      await page.locator('[data-testid="decisions-space-all"]').click()
      await page.waitForTimeout(250)
    }

    // ---- Overview again, with nothing open -------------------------------
    await page.unroute('**/v1/**')
    await page.route('**/v1/**', (route) => clearWorld(route))
    await open(page, `${base}/cockpit/`)
    const quiet = await page.evaluate(BANNER_PROBE)
    const quietNumbers = await page.evaluate(NUMBERS_PROBE)
    if (quiet.banner) {
      note('§8.7', 'Übersicht (Fixture „gate-clear", 0 offene Gates)', `Banner trotzdem sichtbar: „${quiet.text}"`)
    }
    // The other direction of the same rule: nothing open means no banner AND a
    // badge that says zero rather than one that has quietly disappeared —
    // §4's measured null is a number, not an absence.
    if (quietNumbers.nav !== 0) {
      note('§8.1', 'Sidebar-Badge (Fixture „gate-clear")', `Badge liest ${quietNumbers.nav ?? '(fehlt)'} statt 0`)
    }
    if (quietNumbers.zoneA !== 0) {
      note('§1', 'Zone-A-Karte (Fixture „gate-clear")', `Zähler liest ${quietNumbers.zoneA ?? '(fehlt)'} statt 0`)
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
    for (const pattern of ENGLISH_PASSTHROUGH) {
      if (pattern.test(text)) {
        note('§5', `${where} › sichtbarer Text (Backend-Passthrough)`, `„${text.slice(0, 80)}"`)
        break
      }
    }
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
    console.log('   Banner-Satz, Aging-Rubrik, Button-Beschriftung, UUID-Freiheit, Vier-Zahlen-Kohärenz,')
    console.log('   Dubletten-Freiheit, Wiki-Chips ohne Zähler-Wirkung, Zone-A-Anatomie,')
    console.log('   deutsche Oberfläche ohne Backend-Passthrough, Wortmarke)')
    return
  }
  for (const violation of violations) {
    console.error(`\x1b[31m✗\x1b[0m ${violation.rule} · ${violation.where} · ${violation.actual}`)
  }
  console.error(`\n${violations.length} Verstöße gegen COCKPIT-KONVENTION.md v1.4`)
  process.exit(1)
}

await main()
