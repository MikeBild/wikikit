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
// fixtures below through Playwright's page.route, and the pages are served by a
// Vite process this script starts and stops for itself. That is deliberate: a
// conformance check that needs a live stack is a check people run once and then
// stop running, and its verdict would depend on whatever happened to be in
// somebody's database that morning.
//
// AND THAT HAS TWO COSTS, both measured rather than assumed.
//
// 1. The dev server is MORE FORGIVING than delivery in one place: it resolves
//    document-relative hrefs while serving, so `./favicon.svg` leaves as
//    `/cockpit/favicon.svg` on every route. The build does not — such an href
//    survives verbatim into assets/cockpit/index.html and points nowhere on any
//    route of depth >= 2. Measured back when apps/cockpit/index.html still
//    carried `./favicon.svg`: seven violations against the built version, none
//    against the dev server. Since LOCAL-WI-FAVICON-BASEPFAD it reads
//    `/favicon.svg` and both runs are green, so the difference is dormant, not
//    gone: it reappears the moment somebody turns the href back. See
//    checkFavicon().
// 2. Nothing asked WHOSE console answered — only whether something did. Since
//    LOCAL-WI-KENNUNG-NICHT-GEPRUEFT one fetch before the browser starts holds
//    the served `<meta name="cockpit-product">` against apps/cockpit/index.html,
//    the single place it is defined, and throws on a mismatch (exit 2). Why that
//    is not a convention violation, and why neither title nor wordmark can serve
//    as the marker, is at assertTargetIdentity(). Measured against a real
//    WatchKit cockpit on port 4173: the run ended after 0.44s naming the
//    responder. Without the assert the same case ran 20.7s against the foreign
//    console and exited 1 — "measured and red" — without once saying that
//    another product had answered.
//
// THREE TARGETS, and the report says which one this run saw:
//
//   bun scripts/konvention-check.mjs                            # dev server (default)
//   bun run build:cockpit && KONVENTION_CHECK_STAND=preview \
//     bun scripts/konvention-check.mjs                          # built version, as the gate measures
//   COCKPIT_BASE_URL=http://127.0.0.1:4060 bun scripts/konvention-check.mjs   # real delivery
//
// WIRED INTO `bun run gate`, and that was once the other way round: §7 says the
// convention is not technically enforced, and a red mandatory stage blocks every
// piece of work. That held while the check was red. It is green, and an
// assurance nobody asks is a comment (BEFUND-CHECK-LAEUFT-NIRGENDS.md). The
// stage measures with KONVENTION_CHECK_STAND=preview because `check:cockpit-drift`
// rebuilds immediately before it. CI carries the same stage as job `konvention`,
// where the job builds for itself; test/unit/ci-workflows.test.ts holds the two
// lists against each other.
//
// Every violation is collected, never thrown at: one run must produce the whole
// list, because fixing them one rebuild at a time is how a checklist of nine
// rules turns into nine mornings.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// The navigation table, imported rather than restated. `nav.ts` is DOM-free on
// purpose (test/unit/cockpit-navigation.test.ts reads it the same way), so a
// script with no browser around it can ask the console where its pages are.
// A typed list of routes in THIS file would be a second source that cannot
// notice when a page is added — which is how the sweep came to miss every
// detail route in the first place.
import { NAV } from '../apps/cockpit/src/app/nav.ts'

// The identity reader, so this run and the test that holds it read the SAME
// function rather than two that look alike.
import { IDENTITY_META, markerIn } from './kennung.ts'

/*
  The version of the yardstick, READ rather than asserted.

  It used to be a literal in the report lines, and that shape has already been
  wrong once: the copy in the repo said v1.5, the report said v1.4, and both
  looked plausible on their own. A check that asserts its own yardstick's
  version cannot evidence it.

  Missing or malformed header aborts LOUDLY instead of falling back to a
  literal: a report that cannot name its yardstick is not a report (§12).
*/
const CONVENTION_FILE = 'COCKPIT-KONVENTION.md'
const CONVENTION_VERSION = (() => {
  const url = new URL(`../${CONVENTION_FILE}`, import.meta.url)
  let head
  try {
    head = readFileSync(url, 'utf8').slice(0, 2000)
  } catch {
    console.error(`✗ ${CONVENTION_FILE} is missing from the repo root — this run's yardstick cannot be found`)
    process.exit(2)
  }
  const match = head.match(/^Version\s+(\d+\.\d+)\s*·/m)
  if (!match) {
    console.error(
      `✗ ${CONVENTION_FILE} names no version in its header line, in the form \`Version X.Y · …\` — ` +
        'the report could only assert its yardstick, not evidence it',
    )
    process.exit(2)
  }
  return `v${match[1]}`
})()

/*
  The version this check was WRITTEN against — set by hand, and that is the point.

  LABEL AND ASSERT ARE TWO DIFFERENT THINGS. CONVENTION_VERSION above is the
  label and must come from the file. This constant is the assert, and an assert
  needs a SECOND, INDEPENDENT statement: read from the same header, both would
  agree by construction, and a v1.3 copied in would report "against v1.3, no
  violations" — a clean bill of health for an agreement that no longer holds.

  THIS LINE HAS ALREADY BEEN DELETED ONCE, with the reasoning that a number in
  the script is a second source that can only go stale. For a label that is
  true. For an assert it is the description of its job: it has to speak up when
  the file is no longer the family's. "A version bump is then just a `cp`" was
  not a gain but a description of the hole — a `cp` of the WRONG file is just a
  `cp` too.

  The price is one extra line per version bump, next to the `cp`. Deliberate: a
  `cp` of the WRONG file has to be noticeable. Pattern taken from CodeKit's
  checkKonventionVersion(), copied and not imported (§7: no shared code);
  WatchKit and ContentKit carry the same assert.
*/
const EXPECTED_CONVENTION_VERSION = '1.5'

/*
  THE TWO DOCUMENTS ON DISK the DELIVERED one is held against.

  The report says below whether this run measured sharply or only confirmed how
  its target resolves. That used to hang on a PROXY — the presence of
  `/@vite/client` in the delivered document, a string from Vite's internals that
  Vite may rename. It would fail SILENTLY: the caveat disappears and the output
  reads like a sharp run.

  So the property itself is asked instead: WHICH document does the target serve —
  the source, compiled per request, or the built version, verbatim? Both
  comparison strings come from THIS repo and are read at runtime.

  Measured: the favicon href alone cannot answer it. The source writes
  `/favicon.svg`, the dev server delivers `/cockpit/favicon.svg`, the built
  version carries `/cockpit/favicon.svg` — both targets deliver the same href and
  both differ from the source. The href is the EVIDENCE in the report text, not
  the discriminator; the module reference is, because it is the only mark that
  differs between the two documents.
*/
const COCKPIT_SOURCE_HTML = 'apps/cockpit/index.html'
const COCKPIT_BUILT_HTML = 'assets/cockpit/index.html'

/**
 * The two references of a cockpit document, raw from the attribute.
 *
 * Takes HTML rather than a path because the same measurement is needed on THREE
 * documents: the two on disk and the one the target actually delivers. Raw and
 * unresolved on purpose — the question is how the reference STOOD when the
 * target handed it out.
 */
function marksIn(html) {
  // Comments first: apps/cockpit/index.html explains the favicon reference in a
  // comment that writes `href="/cockpit/favicon.svg"` out in full, and a pattern
  // matching that would read the explanation instead of the line.
  html = html.replace(/<!--[\s\S]*?-->/g, '')
  const iconTag = html.match(/<link\b[^>]*\brel=["'][^"']*\bicon\b[^"']*["'][^>]*>/i)
  const attribute = (tag, name) => {
    const match = tag ? tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i')) : null
    return match ? match[1] : null
  }
  const modules = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>/gi)]
    .map((tag) => attribute(tag[0], 'src'))
    .filter(Boolean)
  return { iconHref: attribute(iconTag ? iconTag[0] : null, 'href'), modules }
}

/** The same for a document on disk, or `null` if there is none. */
function documentMarks(relative) {
  try {
    return marksIn(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'))
  } catch {
    return null
  }
}

const SOURCE_MARKS = documentMarks(COCKPIT_SOURCE_HTML)
const BUILT_MARKS = documentMarks(COCKPIT_BUILT_HTML)

const BASE = (process.env.COCKPIT_BASE_URL ?? '').replace(/\/$/, '')
const PORT = Number(process.env.COCKPIT_CHECK_PORT ?? 4173)

/*
  WHICH TARGET this run starts for itself.

  `dev` (default) runs the Vite dev server against apps/cockpit sources: it
  measures what somebody is working on right now and needs no build. The price is
  in the report — it resolves references while serving.

  `preview` runs `vite preview` over assets/cockpit, the BUILT version, with the
  same SPA fallback. Measured: /cockpit/pages/foo answers 200 text/html,
  /cockpit/pages/favicon.svg likewise, /cockpit/favicon.svg image/svg+xml — the
  exact trap checkFavicon() is built for, and one `dev` covers up.

  WHY THE SHARPER TARGET IS NOT THE DEFAULT: `preview` measures what is on disk,
  not what is in the source. Working on apps/cockpit and calling the check would
  give a green verdict for yesterday's build — a false green, and the quietest
  kind. The gate has no such risk: `check:cockpit-drift` runs one stage earlier
  and rebuilds. So the gate picks `preview` and the bare command line `dev`.

  No substitute for COCKPIT_BASE_URL, which points at a server somebody else runs
  — the real delivery through src/cockpit.ts, say. When it is set this run starts
  nothing and this switch does nothing.
*/
const STAND = process.env.KONVENTION_CHECK_STAND ?? 'dev'
if (!['dev', 'preview'].includes(STAND)) {
  console.error(`✗ unknown KONVENTION_CHECK_STAND=${STAND} — allowed are 'dev' and 'preview'`)
  process.exit(2)
}
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

/*
  ── The detail surfaces, one specimen per collection ─────────────────────────

  WHY these exist: until this run the sweep opened the TOP-LEVEL routes and
  nothing else. Every page a reader reaches by clicking a row — a wiki page, an
  archived source, an answer, a proposal under review, a logged decision — was
  outside the check's world, which means §5 (German on the top level, no raw
  identifiers on screen), §2 ("Unbekannt") and §8.3 (button labels) were never
  asserted there at all. That is not a theoretical hole: the same sweep in the
  sibling products found a complete English field table with a full UUID in it
  on one detail page, and an entirely English page on another.

  The identifiers are REAL-shaped UUIDs rather than friendly words, and that is
  the load-bearing part of these fixtures: a detail page that prints its own id
  is precisely the violation being hunted, and a fixture keyed on "quelle-1"
  would let it through.
*/
const CONCEPT_SLUG = 'rueckgaberecht'
const SOURCE_ID = '8e065dc7-4b1a-4c33-9a77-1f0c1d3e5b62'
const OUTPUT_ID = '5c2f9b3a-7d41-4e28-9f61-3a4b2c6d8e90'
const DECISION_SLUG = 'freigabe-bleibt-menschlich'
/** The first open position, so the queue and its detail page are the same object. */
const PROPOSAL_ID = OPEN_ITEMS[0].key.slice('proposal:'.length)

const CITATION = {
  source_id: SOURCE_ID,
  quote: 'Die Rückgabe ist innerhalb von 14 Tagen nach Zustellung möglich.',
  locator: 'Abschnitt 3.2',
  source_title: 'Support-Handbuch 2026',
}

const CONCEPT_DETAIL = {
  slug: CONCEPT_SLUG,
  title: 'Rückgaberecht',
  summary: 'Kundinnen und Kunden können die Ware 14 Tage lang zurückgeben.',
  markdown:
    '## Frist\n\nDie Frist beträgt 14 Tage ab Zustellung.\n\n## Ausnahmen\n\nVerderbliche Ware ist ausgenommen.\n',
  rev: 3,
  updated_at: daysAgo(2),
  claims: [
    {
      id: '22222222-2222-4222-8222-000000000001',
      subject: 'Rückgabe',
      predicate: 'Frist',
      object: '14 Tage ab Zustellung',
      status: 'verified',
      confidence: 0.92,
      citations: [CITATION],
    },
  ],
  relations: [{ to_slug: 'versandkosten', kind: 'related', space: null }],
  agent_meta: {},
}

const CONCEPT_HISTORY = {
  slug: CONCEPT_SLUG,
  revisions: [
    {
      id: '33333333-3333-4333-8333-000000000001',
      rev: 3,
      status: 'current',
      title: 'Rückgaberecht',
      summary: 'Kundinnen und Kunden können die Ware 14 Tage lang zurückgeben.',
      base_revision_id: null,
      proposal_id: null,
      agent_meta: {},
      created_at: daysAgo(2),
    },
  ],
}

const CONCEPT_NEIGHBORS = {
  schema_version: '1',
  relations: [{ slug: 'versandkosten', title: 'Versandkosten', kind: 'related', direction: 'out', space: null }],
  same_source: [{ slug: 'versandkosten', title: 'Versandkosten', shared_sources: 1 }],
}

const SOURCE_DETAIL = {
  id: SOURCE_ID,
  kind: 'markdown',
  url: null,
  title: 'Support-Handbuch 2026',
  raw_title: null,
  summary: 'Das Handbuch des Supports, Stand Frühjahr 2026.',
  content_hash: 'sha256:9f2b1c',
  created_at: daysAgo(30),
  raw_content: '# Support-Handbuch\n\nDie Rückgabe ist innerhalb von 14 Tagen nach Zustellung möglich.\n',
  markdown: '# Support-Handbuch\n\nDie Rückgabe ist innerhalb von 14 Tagen nach Zustellung möglich.\n',
  metadata: {},
  language: 'de',
  stream_id: null,
  source_version: null,
  observed_at: null,
  effective_at: null,
  supersedes_source_id: null,
}

const SOURCE_REFERENCES = {
  items: [{ kind: 'page', id: CONCEPT_SLUG, label: 'Rückgaberecht', href: `/pages/${CONCEPT_SLUG}`, claim_count: 1 }],
  next_cursor: null,
}

/*
  The answer detail, and its summary is the pipeline's ENGLISH sentence on
  purpose — the same passthrough §5 forbids on the queue. It reaches this page
  by the same route (composed in the pipeline, stored on the record, rendered
  wherever the record is shown), so a fixture that quietly wrote German here
  would assert that the detail page is clean without ever putting it to the
  question.
*/
const OUTPUT_DETAIL = {
  id: OUTPUT_ID,
  space_id: SPACES[0].id,
  kind: 'answer',
  title: 'Wie lange ist die Rückgabefrist?',
  summary:
    'Synthesized 8 concepts, 28 claims, 2 contradictions detected from source 8e065dc7-4b1a-4c33-9a77-1f0c1d3e5b62.',
  question: 'Wie lange ist die Rückgabefrist?',
  markdown: 'Die Frist beträgt **14 Tage** ab Zustellung.\n',
  citations: [{ slug: CONCEPT_SLUG, title: 'Rückgaberecht' }],
  not_in_knowledge_base: false,
  agent_run_id: null,
  promoted_ingest_id: null,
  promoted_at: null,
  created_at: daysAgo(3),
}

const DECISION_DETAIL = {
  slug: DECISION_SLUG,
  title: 'Freigaben bleiben menschlich',
  status: 'active',
  created_at: daysAgo(40),
  context: 'Vorschläge aus der Synthese sollen nicht automatisch ins Wiki laufen.',
  decision: 'Jeder Vorschlag braucht eine menschliche Freigabe.',
  rationale: 'Wissensqualität hängt an der Prüfung, nicht am Durchsatz.',
  alternatives: [],
  agent_meta: {},
}

const PROPOSAL_DETAIL = {
  id: PROPOSAL_ID,
  space: SPACES[0].slug,
  status: 'pending',
  title: OPEN_ITEMS[0].title,
  summary: OPEN_ITEMS[0].summary,
  created_at: daysAgo(OPEN_ITEMS[0].ageDays),
  reviewer: null,
  review_note: null,
  review_channel: null,
  reviewed_at: null,
  source_ids: [SOURCE_ID],
  agent_meta: {},
  changes_requested: false,
  parent_proposal_id: null,
  previous_rejection: null,
  concept_lifecycle: [],
  sources: [{ id: SOURCE_ID, title: 'Support-Handbuch 2026', url: null, kind: 'markdown', created_at: daysAgo(30) }],
  concepts: [
    {
      slug: CONCEPT_SLUG,
      is_new: false,
      old_markdown: '## Frist\n\nDie Frist beträgt 14 Tage ab Zustellung.\n',
      new_markdown: '## Frist\n\nDie Frist beträgt 14 Tage ab Zustellung der letzten Teillieferung.\n',
      stale: false,
      claims_added: [{ subject: 'Rückgabe', predicate: 'Frist', object: '14 Tage ab letzter Teillieferung' }],
      claims_disputed: [],
      claims_deprecated: [],
      claims: [
        {
          subject: 'Rückgabe',
          predicate: 'Frist',
          object: '14 Tage ab letzter Teillieferung',
          status: 'verified',
          confidence: 0.88,
          collides: false,
          citations: [CITATION],
        },
      ],
      relations_added: [],
    },
  ],
  decisions: [],
  relations_removed: [],
}

const PROPOSAL_LINT = { findings: [], counts: { error: 0, warn: 0, info: 0 } }

/*
  ── The four records the audit trail is assembled from ───────────────────────

  WikiKit has no audit endpoint, and the trail does not pretend otherwise: it
  reads reviewed proposals, finished ingest runs, page revisions and the
  guidelines' version history, and lays them on one axis. So there are four
  fixtures rather than one, and they are the reason this route is measured as a
  PAGE rather than as an empty state — the contract fallback would have answered
  four empty lists, the trail would have rendered its "nothing recorded yet"
  branch, and the sweep would have been measuring a placeholder.

  They serve /inbox, /pages and /charter as well, which until now also read the
  fallback's empty lists. That widening is deliberate: three more surfaces are
  measured against §5, §2 and §8.3 with rows in them rather than without.

  Every visible string is German and free of identifiers, because a fixture that
  smuggled English or a UUID in here would be testing itself. The `id` fields
  ARE real UUIDs — the trail must not print them, and a fixture keyed on
  "vorschlag-1" would let a page that printed them pass.
*/
const AUDIT_PROPOSALS = {
  items: [
    {
      id: '44444444-4444-4444-8444-000000000001',
      status: 'approved',
      title: 'Rückgaberecht: Frist auf 14 Tage festschreiben',
      summary: 'Zwei Absätze aus dem Support-Handbuch.',
      created_at: daysAgo(12),
      reviewer: 'mike@mikebild.com',
      review_channel: 'rest',
      reviewed_at: daysAgo(11),
      changes_requested: false,
      parent_proposal_id: null,
    },
    {
      id: '44444444-4444-4444-8444-000000000002',
      status: 'rejected',
      title: 'Telefonnummer des Supports ändern',
      summary: 'Die Quelle war nicht mehr aktuell.',
      created_at: daysAgo(9),
      reviewer: 'mike@mikebild.com',
      review_channel: 'mcp_elicitation',
      reviewed_at: daysAgo(8),
      changes_requested: false,
      parent_proposal_id: null,
    },
    // Sent back for rework, and the server leaves it `pending` with a flag. The
    // trail has to file it under "Änderung angefordert" rather than dropping it
    // with the other pending rows — this row is what proves it does.
    {
      id: '44444444-4444-4444-8444-000000000003',
      status: 'pending',
      title: 'Eskalationsweg für Zahlungsausfälle beschreiben',
      summary: 'Der Weg von der ersten Mahnung bis zur Sperrung.',
      created_at: daysAgo(6),
      reviewer: 'mike@mikebild.com',
      review_channel: 'rest',
      reviewed_at: daysAgo(5),
      changes_requested: true,
      parent_proposal_id: null,
    },
    // Still waiting on a person, and therefore NOT in the trail: it is the
    // decisions queue's row. Without it the "only what is finished" rule would
    // be asserted against a fixture that has nothing unfinished in it.
    {
      id: '44444444-4444-4444-8444-000000000004',
      status: 'pending',
      title: 'Urlaubsantrag: Vertretungsregel ergänzen',
      summary: 'Ein Absatz zur Vertretung.',
      created_at: daysAgo(1),
      reviewer: null,
      review_channel: null,
      reviewed_at: null,
      changes_requested: false,
      parent_proposal_id: null,
    },
  ],
}

const AUDIT_INGESTS = {
  items: [
    {
      ingest_id: '55555555-5555-4555-8555-000000000001',
      status: 'done',
      proposal_id: '44444444-4444-4444-8444-000000000001',
      source_id: SOURCE_ID,
      error: null,
      title: 'Support-Handbuch 2026',
      excerpt: null,
      phase: null,
      progress: null,
      created_at: daysAgo(12),
      started_at: daysAgo(12),
      heartbeat_at: null,
      finished_at: daysAgo(12),
    },
    {
      ingest_id: '55555555-5555-4555-8555-000000000002',
      status: 'failed',
      proposal_id: null,
      source_id: null,
      error: { code: 'extract_failed', message: 'Das Dokument war nicht lesbar.' },
      title: 'Betriebsvereinbarung (Entwurf)',
      excerpt: null,
      phase: null,
      progress: null,
      created_at: daysAgo(7),
      started_at: daysAgo(7),
      heartbeat_at: null,
      finished_at: daysAgo(7),
    },
  ],
  next_cursor: null,
}

const AUDIT_CONCEPTS = {
  items: [
    {
      slug: CONCEPT_SLUG,
      title: 'Rückgaberecht',
      summary: 'Kundinnen und Kunden können die Ware 14 Tage lang zurückgeben.',
      rev: 3,
      updated_at: daysAgo(2),
      evidence: { claims: 4, uncited_claims: 0, sources: 2 },
    },
    {
      slug: 'versandkosten',
      title: 'Versandkosten',
      summary: 'Ab 50 Euro Warenwert entfällt der Versand.',
      rev: 1,
      updated_at: daysAgo(20),
      evidence: { claims: 2, uncited_claims: 0, sources: 1 },
    },
  ],
  next_after: null,
  epoch: 1,
}

const AUDIT_CHARTER = {
  items: [
    { rev: 2, status: 'current', created_by: 'mike@mikebild.com', created_at: daysAgo(30) },
    { rev: 1, status: 'superseded', created_by: null, created_at: daysAgo(120) },
  ],
}

/** Every detail read this run models, keyed by the exact pathname. */
function detailReads() {
  const reads = new Map([
    [`/v1/outputs/${OUTPUT_ID}`, OUTPUT_DETAIL],
    [`/v1/proposals/${PROPOSAL_ID}`, PROPOSAL_DETAIL],
    [`/v1/proposals/${PROPOSAL_ID}/lint`, PROPOSAL_LINT],
  ])
  for (const space of SPACES) {
    const prefix = `/v1/spaces/${space.slug}`
    reads.set(`${prefix}/concepts/${CONCEPT_SLUG}`, CONCEPT_DETAIL)
    reads.set(`${prefix}/concepts/${CONCEPT_SLUG}/history`, CONCEPT_HISTORY)
    reads.set(`${prefix}/concepts/${CONCEPT_SLUG}/neighbors`, CONCEPT_NEIGHBORS)
    reads.set(`${prefix}/sources/${SOURCE_ID}`, SOURCE_DETAIL)
    reads.set(`${prefix}/sources/${SOURCE_ID}/references`, SOURCE_REFERENCES)
    reads.set(`${prefix}/decisions/${DECISION_SLUG}`, DECISION_DETAIL)
    // The audit trail's four reads. Keyed by pathname, so the query string the
    // page appends (`?limit=200`) does not have to be modelled.
    reads.set(`${prefix}/proposals`, AUDIT_PROPOSALS)
    reads.set(`${prefix}/ingests`, AUDIT_INGESTS)
    reads.set(`${prefix}/concepts`, AUDIT_CONCEPTS)
    reads.set(`${prefix}/charter/versions`, AUDIT_CHARTER)
  }
  return reads
}

const DETAIL_READS = detailReads()

/*
  ── Which addresses the sweep visits ─────────────────────────────────────────

  Derived, never typed out, and from the two things that actually decide the
  answer:

   - `NAV` names every navigation target, so a page that joins the sidebar
     joins this sweep in the same commit;
   - `router.tsx` names every ROUTE, which is the larger set — the detail pages
     are routed but never listed in the navigation, and those are exactly the
     ones the sweep used to walk past.

  A parameterised route is not an address until somebody says WHICH page:
  `DETAIL_SPECIMENS` names one specimen per collection, and the fixtures above
  serve it. A route whose parameters no fixture covers is NOT skipped — it is
  carried into the report as "not checked" (§12). A gap has to look like a
  gap; silence reads as coverage, and that is the whole reason this hole went
  unnoticed for as long as it did.
*/
const ROUTER_SOURCE = readFileSync(new URL('../apps/cockpit/src/router.tsx', import.meta.url), 'utf8')

const DETAIL_SPECIMENS = {
  '/pages/$slug': { slug: CONCEPT_SLUG },
  '/pages/$slug/edit': { slug: CONCEPT_SLUG },
  '/sources/$id': { id: SOURCE_ID },
  '/answers/$id': { id: OUTPUT_ID },
  '/decisions/proposals/$id': { id: PROPOSAL_ID },
  '/decision-log/$slug': { slug: DECISION_SLUG },
}

function sweepTargets() {
  // The `(?<!base)` is not decoration: `basepath: '/cockpit'` is where the
  // console is MOUNTED, not a route — the same exclusion
  // test/unit/cockpit-navigation.test.ts makes when it reads this file.
  const routed = [...ROUTER_SOURCE.matchAll(/(?<!base)path: '([^']+)'/g)].map((match) => match[1])
  const paths = [...new Set([...NAV.map((entry) => entry.to), ...routed])].sort()
  const visit = []
  const unchecked = []
  for (const path of paths) {
    if (!path.includes('$')) {
      visit.push({ path, url: path })
      continue
    }
    const specimen = DETAIL_SPECIMENS[path]
    if (!specimen) {
      unchecked.push({ path, why: "no fixture for this route's parameters" })
      continue
    }
    const url = path.replace(/\$(\w+)/g, (whole, name) =>
      specimen[name] === undefined ? whole : encodeURIComponent(specimen[name]),
    )
    if (url.includes('$')) unchecked.push({ path, why: 'the fixture does not cover every parameter of the route' })
    else visit.push({ path, url })
  }
  return { visit, unchecked }
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

/*
  ── The reads nobody wrote a fixture for ─────────────────────────────────────

  They used to be answered with `{ items: [], next_cursor: null }`, which is a
  valid answer for a LIST and nonsense for everything else. Five of the
  console's own navigation targets — Wikis, Check, Guidelines, Model usage,
  System — read composed objects rather than lists, so that answer put them on
  the router's bare English "Something went wrong!" screen. The old sweep never
  noticed because it never opened them.

  So the fallback answers what the CONTRACT says instead: docs/openapi.json is
  read, the concrete pathname is matched against the templated one, and a
  minimal instance of the declared response schema is synthesised — arrays
  empty, counters zero, nullable fields null. That is an empty INSTALLATION
  rather than an empty list, which is a state the console has to render anyway,
  and it keeps working when a page grows a read: the contract already describes
  it.
*/
const OPENAPI = JSON.parse(readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'))

/** Dates get a real instant: an empty string renders as "Invalid Date". */
const DATE_FIELD = /(?:_at|^ts|^from$|^to$|_time)$/

function schemaRef(node) {
  if (!node || typeof node !== 'object') return node
  if (!node.$ref) return node
  return OPENAPI.components?.schemas?.[node.$ref.replace('#/components/schemas/', '')]
}

/** The smallest instance the declared schema allows, with nothing in it. */
function emptyInstance(node, field = '', depth = 0) {
  const schema = schemaRef(node)
  if (!schema || typeof schema !== 'object' || depth > 12) return null
  // A nullable union answers null: "measured, nothing there" is the state an
  // empty installation is actually in, and §4 asks for it to be said rather
  // than faked with a zero.
  if (Array.isArray(schema.anyOf)) {
    const nullable = schema.anyOf.find((branch) => schemaRef(branch)?.type === 'null')
    return nullable ? null : emptyInstance(schema.anyOf[0], field, depth + 1)
  }
  if (Array.isArray(schema.enum)) return schema.enum[0] ?? null
  if (schema.type === 'array') return []
  if (schema.type === 'object' || schema.properties) {
    const out = {}
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      out[name] = emptyInstance(property, name, depth + 1)
    }
    return out
  }
  if (schema.type === 'integer' || schema.type === 'number') return 0
  if (schema.type === 'boolean') return false
  if (schema.type === 'string') return DATE_FIELD.test(field) ? new Date(NOW).toISOString() : ''
  return null
}

/** The templated OpenAPI path a concrete request belongs to. */
function contractSchema(pathname) {
  for (const [template, item] of Object.entries(OPENAPI.paths ?? {})) {
    const pattern = new RegExp(
      `^${template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]*\\\}/g, '[^/]+')}$`,
    )
    if (!pattern.test(pathname)) continue
    return item.get?.responses?.['200']?.content?.['application/json']?.schema ?? null
  }
  return null
}

/**
 * One handler for every /v1 read, dispatching on the pathname.
 *
 * Unmatched paths answer an empty-but-contract-shaped body rather than a
 * failure, and are collected so the run can say which reads it did not model
 * by hand. A 404 here would paint the page with error alerts that the banner
 * and empty-state assertions would then be measuring instead of the product.
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

    // The detail reads, last because they are the most specific: a concept, a
    // source, an answer, a proposal, a logged decision. Without them the detail
    // routes below would render the empty-list fallback and the sweep would be
    // measuring a skeleton instead of a page.
    const detail = DETAIL_READS.get(path)
    if (detail) return json(detail)

    unmocked.add(path)
    const shape = contractSchema(path)
    return json(shape ? emptyInstance(shape) : { items: [], next_cursor: null })
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
  const shown = (element) => {
    if (!element) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    const box = element.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }
  const wordmarkIcon = wordmark ? wordmark.querySelector('svg, img, [data-testid="cockpit-wordmark-icon"]') : null
  /*
    The wordmark AS IT STANDS — from the computed spelling, not from innerText.

    innerText was a state-dependent guard and therefore none: it reflects
    text-transform but is empty once the element carries display:none, which is
    exactly what the name line carries when the sidebar is collapsed. The
    fallback then landed on textContent, where "WikiKit" stands regardless of any
    CSS transform, and the all-caps guard was blind.

    So: textContent as the AUTHORED spelling, getComputedStyle().textTransform as
    the applied rule, applied here in JavaScript. text-transform is inherited, so
    measuring at the name element also catches a class on the container — and
    getComputedStyle answers for an element that is not being displayed.
  */
  const nameEl = wordmark ? wordmark.querySelector('[data-testid="cockpit-wordmark-name"]') : null
  const authored = nameEl ? (nameEl.textContent || '').replace(/\\s+/g, ' ').trim() : null
  const transform = nameEl ? getComputedStyle(nameEl).textTransform : null
  const applied =
    authored === null
      ? null
      : transform === 'uppercase'
        ? authored.toUpperCase()
        : transform === 'lowercase'
          ? authored.toLowerCase()
          : transform === 'capitalize'
            ? authored.replace(/(^|\\s)(\\p{L})/gu, (whole, lead, letter) => lead + letter.toUpperCase())
            : authored
  /*
    The favicon reference as the BROWSER resolved it — for checkFavicon(), which
    actually fetches the address.

    The RAW form of both references used to be reported here too, and
    classifyTarget() derived the target from it. It is gone rather than lost:
    since the identity is checked before the browser starts, the delivered
    document is already available as text there and marksIn() reads the same two
    references from it. A second route to the same number is a second route that
    can drift.
  */
  const iconLink = document.querySelector('link[rel~="icon"]')
  return {
    title: document.title,
    icon: iconLink ? { href: iconLink.href, rel: iconLink.getAttribute('rel') } : null,
    wordmark: wordmark
      ? {
          nameElement: Boolean(nameEl),
          name: applied,
          authored: authored,
          transform: transform,
          icon: Boolean(wordmarkIcon),
          iconShown: shown(wordmarkIcon),
        }
      : null,
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

// In a string rather than an arrow function, for the same reason as the probes
// above: this repo's ESLint config deliberately gives .mjs files node globals
// only, so a script reaching for `Image` or `document` outside an evaluated
// probe trips the linter instead of slipping through.
const PAINTS_PROBE = (href) => `(() => new Promise((done) => {
  const probe = new Image()
  probe.onload = () => done({ ok: probe.naturalWidth > 0 && probe.naturalHeight > 0, w: probe.naturalWidth })
  probe.onerror = () => done({ ok: false, w: 0 })
  probe.src = ${JSON.stringify(href)}
}))()`

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
    /*
      What state every rendered position is in, and whether the page offers a
      way to look at any other one.

      Both are read from the DOM rather than assumed from the fixture: the rule
      below is about what a reader can SEE on this page, and a queue that
      rendered a decided position under an open counter would satisfy every
      number-against-number assert in this file.
    */
    states: [...list.querySelectorAll('[data-decision-key]')].map((card) => card.getAttribute('data-state')),
    stateChips: [...document.querySelectorAll('[data-testid^="decisions-state-"]')].map((chip) =>
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
    total: count ? Number(count.getAttribute('data-total')) : null,
    head: clean(head),
    rows: rows.length,
    linkedRows: rows.filter((row) => row.querySelector('a[href]')).length,
    keys: rows.map((row) => row.getAttribute('data-space') + ':' + row.getAttribute('data-decision-key')),
  }
})()`

/*
  The surface probe again, plus the two things a SWEPT route has to say about
  itself: what it calls itself, and whether it is actually the page it claims.

  `notFound` is the false-green guard. Every route below mounts the same `Page`
  shell, so waiting for `[data-testid="page"]` proves nothing about which page
  arrived: a detail address whose fixture stopped matching lands on the
  not-found screen, mounts perfectly, carries no UUID and no English of its own
  — and would be counted as a clean detail page for as long as nobody looked.
*/
const ROUTE_PROBE = `(() => {
  const surface = ${SURFACE_PROBE}
  const title = document.querySelector('[data-testid="page-title"]')
  /*
    The favicon reference resolved AGAINST THIS ROUTE.

    \`link.href\` is the DOM property, not the attribute: it yields the absolute
    address resolved against this document's base. That is the whole difference
    from the measurement on the overview — a document-relative href points
    somewhere else here than it does there.
  */
  const iconLink = document.querySelector('link[rel~="icon"]')
  return {
    icon: iconLink ? { href: iconLink.href, rel: iconLink.getAttribute('rel') } : null,
    texts: surface.texts,
    buttons: surface.buttons,
    title: title ? (title.innerText || title.textContent || '').replace(/\\s+/g, ' ').trim() : null,
    // Two different titles, kept apart here: \`title\` is the page heading,
    // \`documentTitle\` the browser tab label. Only the second is under the
    // family rule.
    documentTitle: document.title,
    notFound: Boolean(document.querySelector('[data-testid="not-found-home"]')),
  }
})()`

/*
  §6 — "the icon stays, the name goes", and what stays stays on the axis.

  Collapsed, the wordmark is the top element of a column of icons, and a square
  sitting two pixels beside that column reads as a misaligned sidebar. Centre
  axes are measured rather than classes: padding can arrive by three routes and
  has to be caught on all three.

  The collapsed state is PRODUCED, not waited for. If it cannot be produced that
  is a finding — a check that returns silently on a missing precondition reports
  compliance where it measured nothing.
*/
const AXIS_PROBE = `(() => {
  const center = (element) => {
    const box = element.getBoundingClientRect()
    return box.width > 0 ? box.left + box.width / 2 : null
  }
  const name = document.querySelector('[data-testid="cockpit-wordmark-name"]')
  const nameBox = name ? name.getBoundingClientRect() : null
  const icon = document.querySelector('[data-testid="cockpit-wordmark-icon"]')
  const navIcons = [...document.querySelectorAll('nav[aria-label] a[data-testid^="nav-"] svg')]
  return {
    collapsed: Boolean(name) && (!nameBox || nameBox.width === 0),
    wordmark: icon ? center(icon) : null,
    nav: navIcons.map(center).filter((value) => value !== null),
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
  // Declared out here because the report needs them even when the run below
  // throws: what was measured, and what was not, are both findings (§12).
  const swept = []
  let unchecked = []
  /*
    What could NOT be measured because a precondition was missing.

    Separate from `violations` because it is a different statement: a violation
    says "something is wrong here", an entry here says "I do not know". Both are
    red — reporting "not checked" as green would be the assurance this check
    never meant to give — but they must not share a line in the report.

    Pattern taken from WatchKit's konvention-check.mjs, copied and not imported
    (§7: no shared code between the products).
  */
  const notChecked = new Set()
  // How many addresses the favicon measurement actually touched. Counted rather
  // than estimated, because the green line at the end names its own scope.
  let faviconChecked = 0
  /*
    Which document does the target deliver? Measured on the DELIVERED document,
    from the same fetch that carries the identity (below, before the browser
    starts).

    The initial value stays "undetermined" and is today NOT reachable: if the
    target answers it is overwritten one line later; if it does not, getWithin
    throws and the run ends through main().catch with "not measured" (2) without
    printing this report. It stands here anyway because a field whose initial
    value would be a lie is worse than one with an unreachable true value — and
    because the unreachability hangs on an ordering somebody can change again.

    What made that ordering load-bearing: report() once sat behind a try/FINALLY
    with no catch, an exception out of open() propagated past it, and the whole
    report vanished. Measured against a target with no server (port 4999, 0.4s):
    no header line, no closing line, only a stack trace, and exit 1 — the same
    code as a cleanly reported violation. The case is shut twice now: the catch
    below catches it, and the identity check runs before it.
  */
  let target = { kind: 'undetermined', why: 'the overview was never read — the run did not get that far' }
  const note = (rule, where, actual) => violations.push({ rule, where, actual })

  /*
    §7 — the convention copy in the repo and this check name the same version.

    The only rule here that needs neither browser nor server, and the only one
    about the check itself. §7 makes the per-repo copy the mechanism against
    drift; a copy that moved on while the check still means the old number turns
    that mechanism into decoration.

    IT COLLECTS LIKE EVERY OTHER RULE and does not halt the run — the house rule
    at the top. A wrong yardstick keeps measuring, it just measures against the
    wrong document, and then the full report is what you want. The two exit-2
    paths on the label may halt because without a readable header nothing CAN be
    measured; here it can.

    Consequence: the message appears at the BOTTOM, after the sweep, because
    report() decides output order — this block's position in the source buys
    nothing. Measured with per-line timestamps at the pipe: the §7 violation
    prints at 26.95s, together with the report header and the closing line,
    because all three come out of report().
  */
  if (CONVENTION_VERSION !== `v${EXPECTED_CONVENTION_VERSION}`) {
    note(
      '§7',
      `${CONVENTION_FILE} › header line`,
      `the copy in the repo says ${CONVENTION_VERSION}, this check is written against v${EXPECTED_CONVENTION_VERSION} — ` +
        'either the copy was replaced without anybody updating the check, or the wrong file was copied in',
    )
  }

  /*
    Everything that can measure sits in this try, and the catch below is why.

    report() used to run behind a try/FINALLY with no catch, so any exception
    from the body — an unresponsive target, a selector with two hits, a timeout —
    propagated past the report and took everything the run had collected with it.
    As a gate stage that is the worst shape there is: a run that checked nothing
    exits with the same code as one that found something, and never says which.

    The exception becomes a `notChecked` entry instead. The run stays red —
    `notChecked` is fatal — but it is red WITH a report.
  */
  /*
    WHOSE CONSOLE ANSWERS — before the browser starts, with exactly one fetch.

    The ordering is the whole assurance: a browser already running has a foreign
    surface in front of it on which every selector in this script finds
    something. So this stands here and not in the try with the measurements —
    there it would become a `notChecked` entry with exit 1, and 1 means
    "measured and red" in this file.

    The SAME fetch carries both: the identity, and the references classifyTarget()
    reads to tell which document the target delivers. A second fetch would be a
    second place needing its own deadline, for nothing: measured, marksIn() over
    this text yields the same classification in both modes that the DOM
    measurement did.
  */
  const location = BASE ? base : `port ${PORT}`
  try {
    const shellHtml = (await getWithin(`${base}/cockpit/`, 15_000)).body
    assertTargetIdentity(shellHtml, location)
    target = classifyTarget(marksIn(shellHtml))
  } catch (error) {
    // The server belongs to this run; a throw must not leave it on the port, or
    // the next run is the one that finds a foreign console — the exact state
    // these lines are written against.
    if (server) await stopCockpit(server)
    // The §7 finding may already be collected and would be lost with the throw.
    // It is a finding about files on disk and untouched by who answered, so it
    // gets printed.
    for (const violation of violations) {
      console.error(`\x1b[31m✗\x1b[0m ${violation.rule} · ${violation.where} · ${violation.actual}`)
    }
    throw error
  }

  let browser = null
  try {
    browser = await chromium.launch()
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
    // case-insensitive test lets "WIKIKIT" pass as a hit, which is precisely
    // the state this assert was written to end.
    if (!shell.wordmark) {
      note('§5/§6', 'Sidebar › wordmark', 'no [data-testid="cockpit-wordmark"] in the DOM')
    } else if (!shell.wordmark.nameElement) {
      // No silent return: without the name line nothing was checked, and "not
      // checked" is a finding (§12), not a passed assertion.
      note('§5/§6', 'Sidebar › wordmark', 'no name line [data-testid="cockpit-wordmark-name"] in the DOM')
    } else {
      const seen = (where) =>
        shell.wordmark.transform && shell.wordmark.transform !== 'none'
          ? `${where} (text-transform: ${shell.wordmark.transform}, authored "${shell.wordmark.authored}")`
          : where
      if (shell.wordmark.name !== PRODUCT_NAME) {
        note(
          '§5/§6',
          'Sidebar › wordmark',
          `"${shell.wordmark.name || '(empty)'}" instead of "${PRODUCT_NAME}" — ${seen('as it stands')}`,
        )
      }
      // A SECOND assert, and not a redundant one: the first catches today's
      // "WIKIKIT", this one catches a name that drifts to all-caps or
      // all-lowercase by some other route — a CSS `text-transform`, say, which
      // the first assert cannot see because it reads the DOM text.
      const name = shell.wordmark.name ?? ''
      if (!name) {
        note('§5/§6', 'Sidebar › wordmark', 'the name line carries no text — not checked')
      } else if (name === name.toUpperCase() || name === name.toLowerCase()) {
        note('§5/§6', 'Sidebar › wordmark', `"${name}" is entirely upper- or lowercase — ${seen('measured')}`)
      }
      // §6 — an icon stands NEXT TO the name, and it is actually painted.
      // Presence in the DOM is not the claim: a glyph in a collapsed container
      // or at zero size is markup that reads as an icon and shows nothing, so
      // this measures the box.
      if (!shell.wordmark.icon) {
        note('§6', 'Sidebar › wordmark', 'no icon element beside the name')
      } else if (!shell.wordmark.iconShown) {
        note('§6', 'Sidebar › wordmark', 'icon element is in the DOM but is not displayed')
      }
    }

    // §6 — the browser tab says "<product name> Cockpit", exactly. The tab is
    // the one part of the console an operator reads with six other tabs open,
    // so it is the place a lowercase product name is most visible and least
    // likely to be noticed by whoever wrote it.
    //
    // §6 rather than §5: v1.5 named the browser title and put it next to the
    // wordmark and the app icon. The assertion measures the same thing as
    // before; only the paragraph a red run cites now points at the rule that
    // actually says it.
    if (shell.title !== `${PRODUCT_NAME} Cockpit`) {
      note('§6', 'browser title <title>', `"${shell.title || '(empty)'}" instead of "${PRODUCT_NAME} Cockpit"`)
    }

    // §6 — the tab reference, on the overview. The measurement itself lives in
    // checkFavicon() because the route sweep needs it again — there against a
    // deep address, where a document-relative href points somewhere else than
    // it does here.
    await checkFavicon(page, note, 'Browser-Tab', shell.icon)
    faviconChecked += 1

    // §5/§6 — one spelling of the role, and it is "Administrator".
    if (shell.role !== 'Administrator') {
      note('§5/§6', 'Sidebar › account block [data-testid="operator-scopes"]', `"${shell.role ?? '(missing)'}"`)
    }
    for (const word of (shell.account ?? '').split(/\s+/)) {
      if (/^admin(istrator)?$/i.test(word) && word !== 'Administrator') {
        note('§6', 'Sidebar › account block', `role spelling "${word}" instead of "Administrator"`)
      }
    }

    // §6 — the admin group is called "Installation", never "Administration".
    if (!shell.installationPresent) {
      note('§6', 'Sidebar › admin group', 'no nav group "installation" in the DOM')
    } else if (shell.installationLabel !== 'Installation') {
      note('§6', 'Sidebar › admin group', `"${shell.installationLabel ?? '(no label)'}"`)
    }

    // §8.1 — the decisions entry is ungrouped, sits directly under the
    // overview, and carries a live counter.
    if (shell.decisionsLabel !== 'Entscheidungen') {
      note('§8.1', 'Sidebar › decisions entry', `"${shell.decisionsLabel ?? '(missing)'}"`)
    }
    if (shell.decisionsGroup !== shell.homeGroup) {
      note(
        '§8.1',
        'Sidebar › decisions entry',
        `grouped under "${shell.decisionsGroup ?? '(no group)'}", the overview sits in "${shell.homeGroup ?? '(no group)'}"`,
      )
    }
    const homeIndex = shell.order.indexOf('nav-home')
    const decisionsIndex = shell.order.indexOf('nav-decisions')
    if (decisionsIndex !== homeIndex + 1) {
      note('§8.1', 'Sidebar › order', `${shell.order.join(' → ')}`)
    }
    if (shell.badge === null) {
      note('§8.1', 'Sidebar › decisions entry', 'no counter badge [data-testid="nav-decisions-count"]')
    }

    // §8.7 — the overview shouts when a gate is open, above everything else,
    // with exactly one link and that link goes to the decisions page.
    if (!banner.page) {
      note('§8.7', 'Overview', 'no [data-testid="page"] — the page did not mount')
    } else if (!banner.banner) {
      note('§8.7', 'Overview (fixture gate-open, 5 open gates)', 'no incident banner in the DOM')
    } else {
      if (!banner.beforeBlocks) {
        note('§8.7', 'Overview › incident banner', `stands behind "${banner.firstBlock ?? '(nothing)'}"`)
      }
      if (banner.links.length !== 1) {
        note('§8.7', 'Overview › incident banner', `${banner.links.length} links: ${banner.links.join(', ') || '—'}`)
      } else if (!/\/decisions(\/|$|\?)/.test(banner.links[0] ?? '')) {
        note('§8.7', 'Overview › incident banner', `link points at "${banner.links[0]}" instead of /decisions`)
      }
    }
    // §1 — Zone A is a CARD: the count and the age in the head, one action per
    // row, and it is the short form of the decisions page rather than a second
    // place to decide. The count is a link, because §1 has no counter without
    // one.
    if (!zoneA.card) {
      note('§1', 'Overview › Zone A', 'no card [data-testid="zone-a"]')
    } else {
      if (zoneA.heading !== 'Wartet auf dich') {
        note('§1', 'Overview › Zone A › heading', `"${zoneA.heading ?? '(none)'}"`)
      }
      if (!zoneA.countInHead) {
        note('§1', 'Overview › Zone A › head', 'no counter [data-testid="zone-a-decisions-count"] in the head')
      } else if (!/\/decisions(\/|$|\?)/.test(zoneA.countHref ?? '')) {
        note('§1', 'Overview › Zone A › counter', `"${zoneA.countHref ?? '(no link)'}" instead of /decisions`)
      }
      // "Age of the oldest position" — either a measured age or the sentence
      // saying there is none. A head with neither reports a number without
      // saying how long it has been true.
      if (!/älteste \d+ Tage|keine datierte Aufgabe/.test(zoneA.head ?? '')) {
        note('§1', 'Overview › Zone A › head', `no age of the oldest position: "${zoneA.head ?? '(empty)'}"`)
      }
      if (zoneA.rows === 0) {
        note('§1', 'Overview › Zone A', 'no positions in the card (fixture gate-open)')
      } else if (zoneA.linkedRows !== zoneA.rows) {
        note('§1', 'Overview › Zone A › rows', `${zoneA.linkedRows} of ${zoneA.rows} rows linked`)
      }
      /*
        The RENDERED rows, not just the number above them (§8.1/§1).

        The four-way comparison below holds four counters against each other and
        still missed a head saying "6 offen" over a table showing seven rows: the
        fixture delivers the first position twice on purpose, the decisions page
        folds it, the Zone-A card did not. Four equal numbers over a wrong list
        are exactly the kind of green a check exists to prevent.

        Two assertions because there are two faults: a duplicate (same keys), and
        a list that does not match its head. The fixture delivers the list in
        full — the same assumption under which the queue below demands
        `data-capped="false"`.
      */
      if (new Set(zoneA.keys).size !== zoneA.keys.length) {
        note('§1', 'Overview › Zone A › duplicates', `${zoneA.keys.length} rows, ${new Set(zoneA.keys).size} positions`)
      }
      if (zoneA.rows !== zoneA.total) {
        note(
          '§1',
          'Overview › Zone A › rows vs. head',
          `the head says ${zoneA.total ?? '(no number)'}, the card shows ${zoneA.rows} rows`,
        )
      }
    }

    collectSurface(note, 'Overview', overview)

    // §8.1/§8.7/§1 — the banner says how much of the queue has gone stale, and
    // it says it in a sentence rather than in a number an operator has to
    // interpret. The regex is the sentence's shape: "N von M", "Alle M" or
    // "mindestens N von M", always followed by the words §8.2 uses for the
    // same three days.
    const SENTENCE = /(?:mindestens \d+ von \d+|Alle \d+|\d+ von \d+) warten länger als drei Tage/
    if (numbers.bannerSubset === null) {
      note('§8.7', 'Overview › incident banner', 'no number [data-testid="incident-decisions-count"]')
    } else {
      if (numbers.bannerSubset !== 'aging') {
        note(
          '§8.7',
          'Overview › incident banner (fixture: 2 of 5 older than three days)',
          `subset "${numbers.bannerSubset}" instead of "aging"`,
        )
      } else if (!SENTENCE.test(numbers.bannerText ?? '')) {
        note('§8.7', 'Overview › incident banner › sentence', `"${(numbers.bannerText ?? '').slice(0, 90)}"`)
      }
      // A subset is a SUBSET: at least one, and never more than the whole
      // queue. "0 von 5" is a banner about nothing and "7 von 5" is a banner
      // about a number nobody counted.
      if (!(numbers.bannerCount > 0 && numbers.bannerCount < numbers.bannerTotal)) {
        note(
          '§8.7',
          'Overview › incident banner › subset',
          `${numbers.bannerCount} of ${numbers.bannerTotal} — not a real subset`,
        )
      } else if (numbers.bannerCount !== AGED_ITEMS) {
        note(
          '§8.7',
          'Overview › incident banner › subset',
          `${numbers.bannerCount} instead of ${AGED_ITEMS} positions older than three days`,
        )
      }
    }

    // ---- Decisions queue, same world -------------------------------------
    await open(page, `${base}/cockpit/decisions?space=${SPACE.slug}`)
    const queueShell = await page.evaluate(SHELL_PROBE)
    const queue = await page.evaluate(QUEUE_PROBE)
    const decisionsSurface = await page.evaluate(SURFACE_PROBE)

    if (!queue.list) {
      note('§8.2', 'Decisions page', 'no queue [data-testid="attention-list"] in the DOM')
    } else if (!queue.headings.includes('Liegt schon länger')) {
      note(
        '§8.2',
        'Decisions queue › aging rubric',
        `headings: ${queue.headings.map((heading) => `"${heading}"`).join(', ') || '(none)'}`,
      )
    }
    collectSurface(note, 'Decisions', decisionsSurface)

    /*
      ---- The decisions page shows the PRESENT ----------------------------

      §8.5 as it now reads. The rule this replaces asked for the opposite: three
      collapsible shelves under the queue — "Zurückgestellt", "Verworfen",
      "Entschieden" — each with a restore action. WikiKit implemented them as
      four tabs over a second, per-wiki endpoint, and that is what came out: the
      cockpit shows the present, the audit trail holds the past, and because the
      past is complete THERE it is not re-served anywhere else. A second,
      shorter history beside a complete one is not redundancy — it is a place
      where a reader can be told a different past, with nothing on screen saying
      which of the two they are reading.

      NOTE ON THE YARDSTICK: the copy of the convention in this repo is v1.5 and
      still carries the shelves. The family text is being pulled to v1.6 in all
      six repositories at once (the copy is deliberately expensive to change,
      §7) — so for one round this check is AHEAD of the document beside it, and
      says so here rather than reporting under a paragraph number that would
      look like it was quoting. The decision is dated 21.08.2026.

      THREE MEASUREMENTS, because the defect has three shapes and each of them
      is reachable on its own:

        - a chip or tab that offers a finished state at all;
        - a rendered position that IS in a finished state;
        - a section heading that names one.

      Counter-checked by rendering a decided position on the page (one line in
      decisions.tsx): the run goes red on the second of the three, which is the
      one no counter and no chip would have caught.
    */
    const FINISHED_HEADINGS = ['Zurückgestellt', 'Verworfen', 'Entschieden']
    if (queue.list) {
      if (queue.stateChips.length) {
        note(
          '§8.5',
          'Decisions page › state selector',
          `offers ${queue.stateChips.join(', ')} — the queue is what waits, not a place to browse what is finished`,
        )
      }
      const finished = (queue.states ?? []).filter((state) => state !== 'open')
      if (finished.length) {
        note(
          '§8.5',
          'Decisions queue › finished positions',
          `${finished.length} of ${queue.states.length} cards carry data-state ${[...new Set(finished)].map((state) => `"${state ?? '(none)'}"`).join(', ')} instead of "open"`,
        )
      }
      const shelfHeading = (queue.headings ?? []).find((heading) =>
        FINISHED_HEADINGS.some((word) => heading === word || heading.startsWith(`${word} `)),
      )
      if (shelfHeading) {
        note('§8.5', 'Decisions queue › section', `a section headed "${shelfHeading}" — that is the audit trail's job`)
      }
      // The guard against a vacuous pass: with nothing rendered, all three
      // assertions above are true and say nothing (§12).
      if (queue.states.length === 0) {
        notChecked.add(
          'the decisions queue rendered no position, so "nothing finished stands here" was not put to the question',
        )
      }
    }

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
      ['nav badge', badgeCount],
      ['Zone-A card', numbers.zoneA],
      ['incident banner', numbers.bannerTotal],
      ['queue', queue.total],
    ]
    const missing = four.filter(([, value]) => !Number.isFinite(value)).map(([name]) => name)
    if (missing.length) {
      note('§8.1/§1', 'four numbers', `without a readable number: ${missing.join(', ')}`)
    } else if (new Set(four.map(([, value]) => value)).size !== 1) {
      note('§8.1/§1', 'four numbers', four.map(([name, value]) => `${name} ${value}`).join(', '))
    }
    // The list is complete in this fixture, so it must not hedge — and the six
    // delivered rows must render as the five positions they are.
    if (queue.capped !== 'false') {
      note('§8.1', 'Decisions queue', `data-capped="${queue.capped}" on a complete list`)
    }
    if (new Set(queue.keys).size !== queue.keys.length) {
      note('§8.2', 'Decisions queue › duplicates', `${queue.keys.length} rows, ${new Set(queue.keys).size} positions`)
    }
    if (queue.keys.length !== queue.cards) {
      note('§8.2', 'Decisions queue', `${queue.cards} cards but ${queue.keys.length} with data-decision-key`)
    }

    /*
      §8.1 — RENDERED positions against the number, and this is the only place
      that crosses that line.

      Everything above holds counters against counters, or rendering against
      rendering. `data-total` and the three other numbers come from
      countOpenDecisions(); `queue.cards` and `queue.keys` both come out of the
      DOM. Neither pair can notice a card that never got rendered.

      Measured at SubKit, in this file's own shape: cutting the render list with
      `groupDecisions(…).slice(0, 1)` produced NOT ONE §8.1 violation, because
      `data-total` did not move and the four numbers still agreed with each
      other. The queue renders in two groups here (`waitingLonger` and
      `currentItems`, decisions.tsx), so a group lost is a group nothing counts.

      Only valid on the UNFILTERED page, and only while the list does not hedge:
      a chip pressed and `data-capped="true"` are both legitimate reasons for
      fewer positions than the number. Both are ruled out above.
    */
    if (queue.capped === 'false' && Number.isFinite(queue.total) && queue.keys.length !== queue.total) {
      note(
        '§8.1',
        'Decisions queue › rendered vs. number',
        `${queue.keys.length} positions rendered, ungrouped there are ${queue.total}`,
      )
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
      note('§10', 'Decisions queue › wiki chips', `chips: ${queue.chips.join(', ') || '(none)'}`)
    } else {
      await page.locator(`[data-testid="${chip}"]`).click()
      await page.waitForTimeout(250)
      const filtered = await page.evaluate(QUEUE_PROBE)
      const filteredShell = await page.evaluate(SHELL_PROBE)
      if (filtered.total !== queue.total) {
        note('§10', 'wiki chip vs. total', `queue ${queue.total} → ${filtered.total} after the chip click`)
      }
      if (filteredShell.badge !== queueShell.badge) {
        note('§10', 'wiki chip vs. nav badge', `badge "${queueShell.badge}" → "${filteredShell.badge}"`)
      }
      if (filtered.cards >= queue.cards) {
        note('§10', 'wiki chip', `filters no rows away: ${queue.cards} → ${filtered.cards}`)
      }
      await page.locator('[data-testid="decisions-space-all"]').click()
      await page.waitForTimeout(250)
    }

    /*
      ---- Every navigation target AND one detail route per collection -------

      §5/§2/§8.3 applied to the pages a reader reaches by CLICKING a row rather
      than by picking a navigation entry.

      Before this, the check opened the overview and the decisions queue and
      called it a sweep. Everything behind a row — a wiki page, its editor, an
      archived source, an answer, a proposal under review, a logged decision —
      was outside the world the check knew about, so the prohibitions on raw
      identifiers, on English on the top level, on "Unbekannt" and on nameless
      buttons simply did not reach them. Not a hypothetical: the same sweep in
      the sibling products walked straight into a full English field table with
      a UUID in it.

      The routes come from `NAV` and from the router, so a page added tomorrow
      is swept tomorrow without anybody remembering this loop exists.
    */
    const targets = sweepTargets()
    unchecked = targets.unchecked
    for (const target of targets.visit) {
      const where = `Route ${target.path}`
      try {
        await open(page, `${base}/cockpit${target.url}?space=${SPACE.slug}`)
      } catch (error) {
        note('§12', where, `does not mount: ${String(error?.message ?? error).split('\n')[0]}`)
        continue
      }
      const surface = await page.evaluate(ROUTE_PROBE)
      if (surface.notFound) {
        note('§12', where, 'lands on the not-found screen — the route is gone, or its fixture no longer matches it')
        continue
      }
      swept.push({ path: target.path, url: target.url, title: surface.title })
      // §6 — the browser tab says "<product name> Cockpit" on EVERY route, not
      // only on the overview.
      //
      // The overview check above holds exactly as long as nobody sets the title
      // per route. Nothing does today — the whole cockpit contains no assignment
      // to `document.title` — and that is why the spot is open: a
      // `document.title = 'Seiten'` in an effect is the most natural addition in
      // a SPA, it leaves the overview green and makes the label silently wrong
      // on twenty-two other routes. The sweep opens every target anyway, so
      // reading the label along costs nothing.
      if (surface.documentTitle !== `${PRODUCT_NAME} Cockpit`) {
        note(
          '§6',
          `${where} › browser title <title>`,
          `"${surface.documentTitle || '(empty)'}" instead of "${PRODUCT_NAME} Cockpit"`,
        )
      }
      // §6 — the same measurement for the tab reference, here against a DEEP
      // address. The reference is document-wide, its resolution is not:
      // `./favicon.svg` yields the right file on /cockpit/ and the address
      // /cockpit/pages/favicon.svg on /cockpit/pages/<slug>, which the SPA
      // fallback answers with 200 and text/html. The overview cannot see that —
      // not because the assert is weak, but because the overview is the one
      // route where it happens to work out.
      //
      // Over the WHOLE sweep rather than one selected detail route: the two
      // requests per route cost so little against the local dev server that a
      // selection would only be a rationale nobody maintains later.
      await checkFavicon(page, note, where, surface.icon)
      faviconChecked += 1
      collectSurface(note, where, surface)
    }

    // ---- Overview again, with nothing open -------------------------------
    await page.unroute('**/v1/**')
    await page.route('**/v1/**', (route) => clearWorld(route))
    await open(page, `${base}/cockpit/`)
    const quiet = await page.evaluate(BANNER_PROBE)
    const quietNumbers = await page.evaluate(NUMBERS_PROBE)
    if (quiet.banner) {
      note('§8.7', 'Overview (fixture gate-clear, 0 open gates)', `banner visible anyway: "${quiet.text}"`)
    }
    // The other direction of the same rule: nothing open means no banner AND a
    // badge that says zero rather than one that has quietly disappeared —
    // §4's measured null is a number, not an absence.
    if (quietNumbers.nav !== 0) {
      note('§8.1', 'sidebar badge (fixture gate-clear)', `badge reads ${quietNumbers.nav ?? '(missing)'} instead of 0`)
    }
    if (quietNumbers.zoneA !== 0) {
      note('§1', 'Zone-A card (fixture gate-clear)', `counter reads ${quietNumbers.zoneA ?? '(missing)'} instead of 0`)
    }

    /*
      ---- The collapsed sidebar, last ------------------------------------

      Last, because collapsing is a state no assert before it should see — and
      because nothing is measured afterwards, it need not be undone.
    */
    const trigger = page.locator('[data-testid="sidebar-trigger"]')
    if ((await trigger.count()) === 0) {
      note('§6', 'sidebar collapsed', 'no [data-testid="sidebar-trigger"] — not checked')
    } else {
      await trigger.first().click()
      await page.waitForTimeout(400)
      const axis = await page.evaluate(AXIS_PROBE)
      if (!axis.collapsed) {
        note('§6', 'sidebar collapsed', 'could not be collapsed — not checked')
      } else if (axis.wordmark === null || axis.nav.length === 0) {
        note(
          '§6',
          'sidebar collapsed › axis',
          `nothing to measure: wordmark square ${axis.wordmark ?? '(no box)'}, ${axis.nav.length} nav icons`,
        )
      } else {
        // All nav icons stand on one axis; one that does not is already a
        // finding, and the comparison below would have no reference.
        const spread = Math.max(...axis.nav) - Math.min(...axis.nav)
        if (spread > 1) {
          note('§6', 'sidebar collapsed › nav icons', `do not stand on one axis themselves (${spread.toFixed(1)}px)`)
        } else if (Math.abs(axis.wordmark - axis.nav[0]) > 1) {
          note(
            '§6',
            'sidebar collapsed › wordmark',
            `square at x=${axis.wordmark.toFixed(1)}, nav icons at x=${axis.nav[0].toFixed(1)}`,
          )
        }
      }
    }

    await context.close()
  } catch (error) {
    // First line, not the whole stack trace: the message belongs in the report,
    // the trace does not. Whatever would have come after is unchecked — which is
    // exactly what the entry says.
    notChecked.add(
      `the run aborted before it could finish measuring: ${String(error).split('\n')[0].trim()} — ` +
        'everything that would have been measured after this point is unknown',
    )
  } finally {
    if (browser) await browser.close()
    if (server) await stopCockpit(server)
  }

  // Here and not in classifyTarget(): "the run never reached the overview" has
  // the same consequence as "I cannot classify the target", and both should get
  // the same red line. The error direction points at red, not at silence — a
  // missing caveat would read like a sharp run.
  if (target.kind === 'undetermined') notChecked.add(`target undeterminable — ${target.why}`)

  report(base, violations, unmocked, swept, unchecked, faviconChecked, target, notChecked)
}

/**
 * §6 — the tab carries an icon, and the file behind it really is one.
 *
 * Measured in THREE steps, none of them decoration:
 *
 *  - A `<link rel="icon">` is there at all.
 *  - It answers 200 AND an image content type. The status code alone would be
 *    especially false-green here: src/cockpit.ts answers anything that is not a
 *    file with the SPA shell — 200, text/html — because deep cockpit addresses
 *    are client routes. A typo in the href gets a cheerful 200 and a page of
 *    HTML.
 *  - The file DECODES as an image. An SVG with a double hyphen in an XML comment
 *    is malformed and fails in the nastiest way: Chromium displays it when the
 *    document is opened directly, fetch returns 200 and image/svg+xml, and in an
 *    <img> it stays empty. A browser loads a favicon as an image. That exact bug
 *    was in this tree and passed every check before this one.
 *
 * WHY A FUNCTION AND NOT ONE SPOT IN THE FLOW: the reference is document-wide,
 * its RESOLUTION is not. `./favicon.svg` yields the right address on /cockpit/
 * and /cockpit/pages/favicon.svg on /cockpit/pages/<slug> — dead, and answered
 * by the SPA fallback with 200 and text/html. Measured on the overview alone
 * that would be green, so the same measurement runs over every address the route
 * sweep opens anyway. The fetch runs IN the page so the href resolves against
 * that document's real base.
 *
 * MEASURED LIMIT, and it applies to the default run: the Vite DEV SERVER resolves
 * a relative href while serving — `./favicon.svg` already leaves as
 * `/cockpit/favicon.svg` on every route. The BUILD does not. So the bug is
 * invisible against the dev server and real in delivery. Measured against the
 * real handler (COCKPIT_BASE_URL=…:4060, built version carrying
 * `./favicon.svg`): seven violations, on exactly the seven routes of depth >= 2,
 * with the overview green throughout. COCKPIT_BASE_URL exists for that.
 *
 * Distinct from test/unit/cockpit-favicon.test.ts, which reads the href
 * STATICALLY from source and built version and computes it against `base` from
 * vite.config.ts — no browser, no server, inside `bun test`, and therefore also
 * when the dev server covers the problem up. Two different statements about the
 * same line; neither replaces the other.
 */
async function checkFavicon(page, note, where, icon) {
  if (!icon) {
    note('§6', where, 'no <link rel="icon"> in the document')
    return
  }
  const answer = await page.evaluate(
    (href) =>
      fetch(href, { cache: 'no-store' }).then(
        (response) => ({ status: response.status, type: response.headers.get('content-type') ?? '' }),
        (error) => ({ status: String(error), type: '' }),
      ),
    icon.href,
  )
  if (answer.status !== 200) {
    note('§6', `${where} › favicon`, `${icon.href} answers ${answer.status}, not 200`)
    return
  }
  if (!/^image\//.test(answer.type)) {
    note(
      '§6',
      `${where} › favicon`,
      `${icon.href} answers "${answer.type || '(no content type)'}" instead of an image — the SPA fallback answered, not the file`,
    )
    return
  }
  const painted = await page.evaluate(PAINTS_PROBE(icon.href))
  if (!painted.ok) {
    note(
      '§6',
      `${where} › favicon`,
      `${icon.href} is served but does not decode as an image (naturalWidth ${painted.w}) — the tab would stay empty`,
    )
  }
}

/** The two DOM-wide prohibitions, applied to whatever page was just measured. */
function collectSurface(note, where, surface) {
  for (const text of surface.texts) {
    if (/\bUnbekannt\b/.test(text)) note('§2', `${where} › visible text`, `"${text.slice(0, 80)}"`)
    if (UUID.test(text)) note('§5/§8.3', `${where} › visible text`, `"${text.slice(0, 80)}"`)
    for (const pattern of ENGLISH_PASSTHROUGH) {
      if (pattern.test(text)) {
        note('§5', `${where} › visible text (backend passthrough)`, `"${text.slice(0, 80)}"`)
        break
      }
    }
  }
  for (const label of surface.buttons) {
    if (FORBIDDEN_BUTTONS.includes(label.toLowerCase())) {
      note('§8.3', `${where} › button`, `labelled "${label}"`)
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
 *
 * AND `--strictPort` DOES NOT PROTECT what it looks like it protects. The idea
 * would be: somebody else holds the port, vite exits, and the run cannot measure
 * against a foreign target. Measured, it is the other way round. Started with a
 * real sibling cockpit on 4173, this function returned after 0.44s with a DEAD
 * child process: the loop asks `child.exitCode` BEFORE the fetch, on the first
 * pass vite has not yet reported its port conflict, and the fetch is answered
 * immediately by the foreign server. `return child` — and nobody noticed our own
 * server never ran.
 *
 * Swapping the order would shrink the window, not close it; the case is caught
 * one level up by the identity check, which also gives the better message: not
 * "vite exited" but who answered instead.
 */
async function startCockpit() {
  const child = spawn(
    'bunx',
    [
      'vite',
      ...(STAND === 'preview' ? ['preview'] : []),
      '--config',
      VITE_CONFIG,
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--strictPort',
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (chunk) => log.push(String(chunk)))
  child.stderr.on('data', (chunk) => log.push(String(chunk)))

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(`✗ the cockpit ${STAND} server exited with ${child.exitCode}\n${log.join('')}`)
      process.exit(2)
    }
    try {
      // Through getWithin rather than a bare `fetch`: a process that holds the
      // port, accepts the connection and never answers leaves a signal-less
      // `fetch` hanging, so `Date.now() < deadline` is never reached again and
      // the 60-second deadline is decoration. The body is read and discarded
      // because "the headers arrived" is not "the server answers".
      if ((await getWithin(`http://127.0.0.1:${PORT}/cockpit/`, 2_000)).ok) return child
    } catch {
      // Not listening yet. The deadline, not this catch, decides when to give up.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  child.kill('SIGTERM')
  console.error(`✗ the cockpit ${STAND} server did not answer on ${PORT} within 60s\n${log.join('')}`)
  process.exit(2)
}

async function stopCockpit(child) {
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    child.once('exit', resolve)
    setTimeout(resolve, 5_000)
  })
}

/**
 * The ONLY node-side `fetch` call site in this file, with a deadline over the
 * whole exchange.
 *
 * Why exactly one: a deadline is a property of the call site, and every further
 * site is one that can be forgotten. WatchKit merged its call sites the same way
 * after a deadline was retrofitted twice and the hang moved one line rather than
 * going away. test/unit/konvention-check-kennung.test.ts holds the count.
 *
 * The signal stays in force WHILE the body is read: a server that sends headers
 * and leaves the body open is exactly the state a signal-less `fetch` survives
 * here.
 */
async function getWithin(url, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: response.ok, body: await response.text() }
  } catch (error) {
    // The bare message of an expired signal is "The operation was aborted due to
    // timeout" — true and placeless. Whoever reads that in the gate needs the
    // address and the deadline, or they hunt the hang in the browser instead of
    // in the server.
    throw new Error(
      `${url} did not answer within ${(timeoutMs / 1000).toFixed(0)}s: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHOSE CONSOLE ANSWERS
//
// startCockpit() answers "does something answer there?", not "does WIKIKIT
// answer there?". Not a theoretical gap: at CodeKit it happened — WorkKit held
// CodeKit's check port, and the run produced eight violations under CodeKit's
// name in 156s over a surface that was never CodeKit. No timeout, no crash: a
// complete, convincing, wrong report. A timeout gets investigated; eight
// violations get repaired.
//
// The family is especially exposed to this through two decisions that are each
// right on their own. The convention makes the DOM anchors identical across all
// six consoles ON PURPOSE — `cockpit-wordmark`, `operator-role`, `sidebar`,
// `page-title` — so every line of this script finds something in every sibling
// console. And the check ports sit close together: CodeKit 4081 · WikiKit 4173 ·
// SubKit 4176 · WatchKit 4183 · WorkKit 4192, plus a foreign server on 4080
// since 7 August. A typo in COCKPIT_CHECK_PORT is enough.
//
// WHY THE EXPECTED VALUE IS DERIVED AND NOT TYPED OUT
//
// CodeKit solved it first and named its own solution's weakness: there the
// marker is a LITERAL in the check script while a contract test imports the same
// value. Rename it and the check says "foreign document" about its OWN console —
// the message that is most expensive when wrong, because it points the wrong way.
//
// So there is exactly ONE place of definition here, apps/cockpit/index.html, and
// this assert READS it. Change the value and both sides move together. Rename
// the ATTRIBUTE and you do not get "foreign document" but the sentence that is
// true: the expected value can no longer be derived from that file — a finding
// about THIS repository and no statement about the other end.
//
// And explicitly NOT the title or the wordmark: both are rules this run must be
// able to find broken (§6 browser title, §6 wordmark). An identity that is also
// under test turns every real violation into "that is not WikiKit at all" and
// measures nothing afterwards. For the same reason this assert does not use
// PRODUCT_NAME.
//
// WIKIKIT'S SPECIALITY: TWO TARGETS, ONE FETCH
//
// This check is the only one in the family measuring against two targets — the
// dev server and (the gate stage) `vite preview` over the built version. So the
// identity has to survive the build too; test/unit/cockpit-embedded-drift.test.ts
// holds it in the built bundle against the name from package.json. And the
// sharpness caveat recognises the target from the DELIVERED document — the same
// document that carries the identity. Both now read ONE fetch.
// ─────────────────────────────────────────────────────────────────────────────

// The reader itself lives in scripts/kennung.ts, and not for tidiness: this
// file runs on import, so a test can only hold the reader against fixtures once
// it can be imported alone. It could not, and the hole that hid behind that is
// LOCAL-WI-KENNUNG-BEISPIEL-GEWINNT.

/**
 * Checks WHOSE console answered — before a single rule is measured and before a
 * browser starts at all.
 *
 * Throws instead of reporting, on purpose: a foreign target is not a convention
 * violation but a run that did not happen. The throw lands in `main().catch`,
 * which prints "not measured" and exits 2 — the distinction this file otherwise
 * already makes between "measured and red" (1) and "not measured" (2).
 *
 * Three branches, three different sentences, because they are three different
 * situations and the difference is the whole work for whoever reads the message.
 */
function assertTargetIdentity(html, location) {
  const sourceUrl = new URL(`../${COCKPIT_SOURCE_HTML}`, import.meta.url)
  const expected = markerIn(readFileSync(sourceUrl, 'utf8'))
  if (expected === null) {
    throw new Error(
      `${COCKPIT_SOURCE_HTML} carries no single <meta name="${IDENTITY_META}" content="…"> outside a ` +
        'comment — none, or more than one. The identity assert derives its expected value from that file ' +
        `and now has none — this is a finding about THIS repository and no statement about the target on ${location}.`,
    )
  }
  const delivered = markerIn(html)
  if (delivered === null) {
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim() ?? '(no <title>)'
    /*
      Two readings, and the title decides between them — which is why it is in
      the message. Either a sibling console that does not carry the marker yet is
      listening (five of the six products do not), or it is our own shell that
      lost it on the way. The second case is not theoretical: measured by removing
      the line from assets/cockpit/index.html only — the preview run ended here
      after 1.4s, with the title "WikiKit Cockpit" in the message.
    */
    throw new Error(
      `this is not ${expected}: the document on ${location} carries no single <meta name="${IDENTITY_META}"> ` +
        'outside a comment. ' +
        `Its title reads "${title}" — is a sibling console listening there, or is it our own shell that ` +
        `lost the marker in the build? The DOM anchors are the same family-wide, so this run would have ` +
        `measured them either way and attributed every violation to ${expected}.`,
    )
  }
  if (delivered !== expected) {
    throw new Error(
      `this is not ${expected} but ${delivered}: the document on ${location} calls itself "${delivered}", ` +
        `${COCKPIT_SOURCE_HTML} names "${expected}". Nothing was measured.`,
    )
  }
  return expected
}

/**
 * Which document does the target deliver — the source, compiled per request, or
 * the built version, verbatim?
 *
 * THIS IS THE QUESTION THIS RUN'S SHARPNESS HANGS ON, and it has had a wrong
 * shape here once. It used to ask "is `/@vite/client` in the delivered
 * document?", which measures a trace of the property rather than the property —
 * a string from Vite's internals that Vite may rename. And it failed unsafely:
 * lose the trace and the caveat disappears SILENTLY, so the output reads like a
 * sharp run.
 *
 * What is measured now is the delivered document's module reference against the
 * two documents on disk. Both comparison strings come from this repo and are
 * read at runtime:
 *
 *   - carries the delivered document the reference from assets/cockpit/index.html,
 *     it is the built version — served verbatim, so what is measured is what
 *     ships;
 *   - ends one of the delivered references on the reference from
 *     apps/cockpit/index.html (`/cockpit/src/main.tsx` on `/src/main.tsx`), the
 *     document was produced from source on this request, and references are
 *     resolved in the process;
 *   - matches neither, the target is UNDETERMINED, and that is said.
 *
 * WHY NOT THE FAVICON HREF ALONE, though it names the property more directly: it
 * does not separate the two targets today. Measured — the source writes
 * `/favicon.svg`, the dev server delivers `/cockpit/favicon.svg`, the built
 * version carries `/cockpit/favicon.svg` and ships it. Both targets deliver the
 * same href and both differ from the source. The href is the EVIDENCE in the
 * report, not the discriminator.
 */
function classifyTarget(delivered) {
  const undetermined = (why) => ({ kind: 'undetermined', why })
  if (!delivered) return undetermined('the overview returned no references')
  if (!SOURCE_MARKS) return undetermined(`${COCKPIT_SOURCE_HTML} is unreadable — there is nothing to compare against`)
  if (!BUILT_MARKS) {
    return undetermined(`${COCKPIT_BUILT_HTML} is unreadable — the built version is missing (bun run build:cockpit)`)
  }
  const source = SOURCE_MARKS.modules[0] ?? null
  const built = BUILT_MARKS.modules[0] ?? null
  if (!source || !built) {
    return undetermined(
      `no <script type="module" src=…> in ${source ? COCKPIT_BUILT_HTML : COCKPIT_SOURCE_HTML} — ` +
        'the mark the two documents differ on is missing',
    )
  }
  const evidence = {
    source,
    built,
    authoredIcon: SOURCE_MARKS.iconHref,
    builtIcon: BUILT_MARKS.iconHref,
    deliveredIcon: delivered.iconHref,
  }
  if (delivered.modules.includes(built)) return { kind: 'built', ...evidence }
  const fromSource = delivered.modules.find((src) => src === source || src.endsWith(source))
  if (fromSource) return { kind: 'source', fromSource, ...evidence }
  return undetermined(
    `the delivered document carries neither the built version's module reference ("${built}") nor one ending ` +
      `on the source reference ("${source}") — delivered was: ` +
      (delivered.modules.length ? delivered.modules.map((src) => `"${src}"`).join(', ') : '(no module reference)'),
  )
}

/**
 * The target, named on EVERY path through the report.
 *
 * Before the closing line and not below it: the caveat used to sit in the green
 * branch, right under "✓ no convention violations". It qualifies the whole run,
 * not just a green result — a favicon violation from a limited run is just as
 * limited. And it therefore sat in the one place the gate never shows: a passing
 * stage prints nothing there.
 */
function printTarget(target, faviconChecked) {
  const sweepAddresses = Math.max(faviconChecked - 1, 0)
  if (target.kind === 'undetermined') {
    console.error(`\x1b[31m✗ target undeterminable\x1b[0m — ${target.why}.`)
    console.error('  Whether this run measured sharply or only confirmed how its target resolves is therefore')
    console.error('  unknown. It is said because a MISSING caveat would read like a sharp run.')
    return
  }
  if (target.kind === 'built') {
    console.log('› target: the BUILT version. The delivered document carries the module reference from')
    console.log(`  ${COCKPIT_BUILT_HTML} ("${target.built}") — it was not produced from`)
    console.log(`  ${COCKPIT_SOURCE_HTML} on this request.`)
    if (target.deliveredIcon === target.builtIcon) {
      console.log(`  The favicon reference came back as "${target.deliveredIcon}", exactly as the built version`)
      console.log(`  carries it: the ${faviconChecked} measured addresses see the resolution that also ships.`)
    } else {
      console.log(`  The favicon reference came back as "${target.deliveredIcon ?? '(none)'}", the built version`)
      console.log(`  carries "${target.builtIcon ?? '(none)'}" — so the target does not serve the document verbatim.`)
    }
    return
  }
  console.log('\x1b[33m! measured with a caveat\x1b[0m — the target produces its document per request from')
  console.log(`  ${COCKPIT_SOURCE_HTML}: the delivered module reference "${target.fromSource}" ends on the`)
  console.log(`  source reference "${target.source}", while the built version carries "${target.built}".`)
  if (target.authoredIcon && target.deliveredIcon && target.authoredIcon !== target.deliveredIcon) {
    console.log(`  Measured at the favicon: the source writes "${target.authoredIcon}", delivered was`)
    console.log(`  "${target.deliveredIcon}" — so the target resolves the source href while serving.`)
  } else if (target.authoredIcon && target.authoredIcon === target.deliveredIcon) {
    console.log(`  Measured at the favicon: the source writes "${target.authoredIcon}", and it came back`)
    console.log('  unchanged — this one reference was not touched while serving.')
  } else {
    console.log(
      `  The favicon reference could not be held against the source (source: ${target.authoredIcon ?? '(none)'}, ` +
        `delivered: ${target.deliveredIcon ?? '(none)'}).`,
    )
  }
  console.log(`  For the favicon that means: the ${sweepAddresses} sweep addresses cannot return a different`)
  console.log('  verdict here than the overview — a document-relative href ("./favicon.svg") is resolved while')
  console.log('  serving, but survives verbatim in the BUILT version and points nowhere there on every route')
  console.log('  of depth >= 2. The measurement gets sharp against the BUILT version, the way the gate stage')
  console.log('  measures it:')
  console.log('    bun run build:cockpit && KONVENTION_CHECK_STAND=preview bun run konvention:check')
  console.log('  or against the real delivery through src/cockpit.ts:')
  console.log('    bun run build:cockpit && bun bin/wikikit.ts')
  console.log('    COCKPIT_BASE_URL=http://127.0.0.1:4060 bun run konvention:check')
  console.log('  In the default run test/unit/cockpit-favicon.test.ts holds this spot (without a server).')
}

function report(base, violations, unmocked, swept, unchecked, faviconChecked, target, notChecked) {
  console.log(
    `› checked the cockpit at ${base} against ${CONVENTION_FILE} ${CONVENTION_VERSION} (fixtures, no database)`,
  )
  console.log(`› route sweep (${swept.length}): ${swept.map((route) => route.path).join(', ') || '(none)'}`)
  // Said out loud, on EVERY path through this function, and before the verdict.
  // §12: a gap appears as a gap. A route the fixtures cannot reach is not a
  // route that passed — and a run that mentions it only when something else is
  // already red would announce the hole exactly when nobody is reading.
  if (unchecked.length) {
    console.log('\x1b[33m! not checked\x1b[0m — the sweep did NOT open these routes:')
    for (const route of unchecked) console.log(`  · ${route.path} — ${route.why}`)
  }
  if (unmocked.size) {
    console.log(
      `› reads answered from the contract (empty instance of the declared schema) because no fixture models them by hand: ${[...unmocked].join(', ')}`,
    )
  }

  printTarget(target, faviconChecked)

  // "I do not know" before "something is wrong here": a missing precondition
  // often explains the violations below it, and above all it explains which
  // statements this run did NOT make.
  if (notChecked.size) {
    console.error('\x1b[31mnot checked — the precondition was missing, the result is unknown:\x1b[0m')
    for (const entry of [...notChecked].sort()) console.error(`  · ${entry}`)
    console.error('  None of it was reported as clean. A gap appears as a gap (§12).')
  }
  for (const violation of violations) {
    console.error(`\x1b[31m✗\x1b[0m ${violation.rule} · ${violation.where} · ${violation.actual}`)
  }

  if (!violations.length && !notChecked.size) {
    console.log('\x1b[32m✓ no convention violations\x1b[0m')
    // Said out loud rather than left implied: green means these rules held
    // against these fixtures, not that the console is conformant.
    console.log('  (role label, installation group, decisions entry, state word, incident banner,')
    console.log('   banner sentence, aging rubric, button labels, freedom from UUIDs, four-number coherence,')
    console.log('   freedom from duplicates, wiki chips without counter effect, Zone-A anatomy,')
    console.log('   Zone-A rows duplicate-free and matching their head,')
    console.log('   queue positions rendered held against the number, not against each other,')
    console.log('   the decisions page free of finished positions (state selector, card state, section heading),')
    console.log('   German surface without backend passthrough, wordmark, browser title on every route,')
    console.log('   wordmark icon (spelling from the computed text-transform, not from innerText),')
    console.log(
      `   favicon that really loads and decodes as an image (measured on ${faviconChecked} addresses, overview and sweep routes),`,
    )
    console.log('   wordmark square collapsed on the axis of the nav icons,')
    console.log('   route sweep over every navigation target and one detail route per collection,')
    console.log(
      `   yardstick version: the copy's header line and the constant in this script both name ${CONVENTION_VERSION})`,
    )
    return
  }
  // BOTH numbers, always. "0 not checked" is a statement, not noise: it says the
  // run reached its end and the finding above it is a measurement rather than an
  // abort.
  console.error(
    `\n${violations.length} violations, ${notChecked.size} spots not checked — measured against ${CONVENTION_FILE} ${CONVENTION_VERSION}`,
  )
  process.exit(1)
}

/*
  The three exits of this run.

  0 is "measured and green", 1 is "measured and red" (report() sets it), and 2 is
  "NOT measured". A gate treats 1 and 2 alike; a human does not. Without this
  catch the throw from the identity assert would be an unhandled rejection: a
  stack trace instead of a statement, and an exit code nobody promised.
*/
await main().catch((error) => {
  console.error(`\n\x1b[31mnot measured\x1b[0m — the run did not reach a statement:`)
  console.error(`  ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
})
