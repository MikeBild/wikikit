/**
 * The rules the search surface runs on, with no DOM under them.
 *
 * It may reach for another page's rules by the console's own `@/` alias — the
 * root tsconfig maps it onto `apps/cockpit/src` precisely so `test/unit/` can
 * hold these modules by the same path the console imports them with. What it
 * must not reach for is a browser: `lib` there is ES2023 with no DOM, so a
 * module that touches `window` or `localStorage` stops typechecking the moment
 * a test loads it, which is the pressure that keeps these rules provable.
 */
import { pageEvidence, type EvidenceCounts, type NotMeasured, type PageEvidence } from '@/pages/page.logic'
import type { FilterSpec } from '@/lib/url-filters'

/**
 * How many hits this console asks for PER TIER.
 *
 * `zSearchQuery` allows a `limit` up to 50 and applies it to each tier
 * separately, so 50 was available and was deliberately not taken. Two reasons,
 * and the second is the one that decided it:
 *
 * A ranked list is not a log. The tail of a `ts_rank` ordering is where the
 * words stopped matching, so the answer to "my hit is not in here" is different
 * words, never more rows — unlike the delivery log or the change queue, where
 * the missing row is the whole errand and the only fix is a bigger read.
 *
 * And this page has no pagination. `approved_then_sources` at 25 already puts
 * fifty cards on one unbroken scroll; asking for the server's 50 would put a
 * hundred there and STILL end at a ceiling, one twice as far from the search
 * box that is the actual way out. So the console keeps its own smaller number
 * and — this is the part that was missing — says when it has been reached.
 */
export const RESULT_LIMIT = 25

/**
 * The sentence a tier gets when it came back full, or `null`.
 *
 * "25 hits on pages a human reviewed and published" is a count that reads as a
 * total, and at exactly the limit it is not one: the reader is looking at the
 * top of a ranking whose remainder this page never asked for. The note names
 * the ceiling and points at the only control that reaches past it — nobody can
 * scroll their way to a hit the server never sent.
 *
 * `null` below the ceiling rather than a softer sentence: a search that
 * returned nine hits returned every hit there is, and a permanent "there may be
 * more" would teach a reader to distrust the count that is true.
 */
export function resultCeilingNote(loaded: number, unit: 'hits' | 'excerpts'): string | null {
  if (loaded < RESULT_LIMIT) return null
  return `Only the ${RESULT_LIMIT} highest-ranked ${unit} are shown and there may be more — the list does not go further, so narrower words are what reach them.`
}

/* --------------------------------------------- narrowing the archived tier */

/**
 * The two filters that narrow archived sources — and NOTHING else on the page.
 *
 * `zSearchQuery` takes them as `evidence_from`/`evidence_to` and
 * `evidence_source_kind`, and the server applies them to the source-evidence
 * arm alone: an approved hit is dated by the review that published it and typed
 * `concept|claim`, so neither an arrival window nor a document kind is a
 * question it can answer. That is why they are addressed `evidence_*` here too
 * — a reader who shares the URL is sharing a claim about one half of the page.
 *
 * Closed alphabets, like every other filter this console offers: the age is
 * three windows the console converts to an instant, the kind is the alphabet a
 * client may declare on ingest. Anything else in the address falls back to
 * "do not narrow", which is what an unset filter already means.
 */
export const EVIDENCE_FILTERS: readonly FilterSpec[] = [
  { key: 'evidence_age', values: ['7d', '30d', '90d'], fallback: 'any' },
  { key: 'evidence_kind', values: ['meeting', 'article', 'note'], fallback: 'any' },
]

/** The age windows in the order the control offers them; `any` is the neutral head. */
export const EVIDENCE_AGE_WINDOWS = ['any', '7d', '30d', '90d'] as const

/** The kinds in the order the control offers them; `any` is the neutral head. */
export const EVIDENCE_KIND_VALUES = ['any', 'meeting', 'article', 'note'] as const

export const EVIDENCE_AGE_LABEL: Readonly<Record<string, string>> = {
  any: 'Any time',
  '7d': 'Archived in the last 7 days',
  '30d': 'Archived in the last 30 days',
  '90d': 'Archived in the last 90 days',
}

export const EVIDENCE_KIND_LABEL: Readonly<Record<string, string>> = {
  any: 'Any kind',
  meeting: 'Meetings',
  article: 'Articles',
  note: 'Written notes',
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Day counts for the age alphabet; anything else is "do not narrow".
 *
 * Not the pages index's `CHANGE_WINDOWS`, though the numbers match today: that
 * one is a window over when a PAGE last changed, this one over when a SOURCE
 * arrived, and folding them together would make a future change to either one
 * silently move the other.
 */
const EVIDENCE_AGE_DAYS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90 }

/**
 * What the two filters add to the search request.
 *
 * Empty in `approved_only`, and that is the whole reason this takes the mode:
 * with no archived tier in the answer there is nothing for these to narrow, so
 * sending them would put a condition in the address that changes no result —
 * a filter a reader could set, share and never see act.
 *
 * The age becomes an INSTANT here rather than a window on the wire, for the
 * reason `pages.tsx` computes its cut-off from the shared clock: `7d` read at
 * the server would move every time the request was repeated, and two searches
 * a reader believes are the same search would answer differently. The caller
 * passes `now` — reading the wall clock inside a render is what that rule
 * exists to prevent.
 *
 * And the instant is floored to the HOUR, which is not cosmetic: this object
 * becomes part of the react-query key, and a cut-off that moved once a second
 * would make every second's render a different query — a search re-fetched
 * sixty times a minute for a boundary nobody can perceive. An hour-aligned
 * edge on a seven-day window is precision the filter never claimed.
 *
 * `evidence_to` is deliberately never sent. The control offers "archived
 * within the last N days", which has no upper edge; the parameter exists on the
 * wire for callers with a closed window and this console has no control that
 * would fill it honestly.
 */
export function evidenceQuery(
  mode: 'approved_only' | 'approved_then_sources',
  age: string,
  sourceKind: string,
  now: number,
): { evidence_from?: string; evidence_source_kind?: string } {
  if (mode !== 'approved_then_sources') return {}
  const days = EVIDENCE_AGE_DAYS[age]
  const since = Math.floor((now - (days ?? 0) * DAY_MS) / HOUR_MS) * HOUR_MS
  return {
    ...(days === undefined ? {} : { evidence_from: new Date(since).toISOString() }),
    ...(sourceKind === 'any' || !EVIDENCE_KIND_LABEL[sourceKind] ? {} : { evidence_source_kind: sourceKind }),
  }
}

/**
 * The filters currently narrowing the archive, in the operator's words.
 *
 * An empty result under a filter reads as "this wiki holds nothing on the
 * subject" unless the page says what it was narrowed by — and on THIS page the
 * mistaken reading is expensive, because the reader's next move is to conclude
 * the archive is silent and go ask a person instead.
 */
export function activeEvidenceFilters(
  mode: 'approved_only' | 'approved_then_sources',
  age: string,
  sourceKind: string,
): string[] {
  if (mode !== 'approved_then_sources') return []
  return [
    ...(EVIDENCE_AGE_DAYS[age] === undefined ? [] : [EVIDENCE_AGE_LABEL[age]!]),
    ...(sourceKind === 'any' || !EVIDENCE_KIND_LABEL[sourceKind] ? [] : [EVIDENCE_KIND_LABEL[sourceKind]!]),
  ]
}

/**
 * Why nothing came back — and the rule is that a narrowed search never blames
 * the words.
 *
 * Three worlds, and they are three different next moves: search elsewhere,
 * widen the tier, or drop the filter. Saying "nothing contains those words"
 * over a filtered archive would send a reader to rewrite a query that was
 * never the problem.
 */
export function searchEmptyDescription(
  mode: 'approved_only' | 'approved_then_sources',
  age: string,
  sourceKind: string,
): string {
  if (mode === 'approved_only') {
    return 'No approved page or claim contains those words. The archived sources behind this wiki have not been searched.'
  }
  const active = activeEvidenceFilters(mode, age, sourceKind)
  if (active.length === 0) return 'Neither the approved pages nor the archived sources contain those words.'
  return `No approved page or claim contains those words, and the archived sources were narrowed to ${active
    .map((label) => label.toLowerCase())
    .join(' and ')} — widening that is what reaches the rest of the archive.`
}

/**
 * The part of a search hit that decides whether it has page evidence to show.
 *
 * `tier` and `kind` are the closed alphabets `zSearchResponse` declares, spelled
 * out rather than widened to `string`, so the day the server grows a fourth
 * `kind` this gate fails to compile instead of silently deciding for it —
 * whether a new kind of hit is a page is a judgement, not a default.
 *
 * `evidence` is optional and nullable HERE while the wire declares it required
 * on a concept hit, and for the same reason `PageRow` in `pages.tsx` does it:
 * this console is served by the binary it talks to, so the two normally agree,
 * and a ROLLING UPGRADE is where they stop — a tab loaded from the replaced
 * instance, its next search landing on the one still running the old build. The
 * hits that come back then carry no `evidence` at all, and typing it required
 * would be a lie the compiler agreed to.
 */
export interface EvidenceBearingHit {
  tier: 'approved' | 'source_evidence'
  kind: 'concept' | 'claim' | 'source_chunk'
  evidence?: EvidenceCounts | null
  /**
   * The other half of the pair, and it must be here for the same reason it is on
   * the index row: the two surfaces are two reads of one page, and a hit that
   * fell silent about a withheld count while the index row named it would be the
   * console showing a reader two different wikis. Read exactly as the index
   * reads it — `pageEvidence` owns what it means, this module only decides
   * whether the hit in front of it is a page at all.
   */
  not_measured?: NotMeasured | null
}

/**
 * Which hits are PAGES — the only hits an evidence summary belongs on.
 *
 * One caller, since the server started saying why a measurement is absent and
 * the response-wide discriminator that was the second caller went away. The gate
 * stays a named predicate rather than an inline condition because what it
 * encodes is a judgement about kinds of hit, and the two paragraphs below are
 * the judgement.
 *
 *  - **A `source_evidence` hit is never a page, whatever the response
 *    contains.** It is a line a document happened to hold — nobody approved it,
 *    nothing vouches for it, and it is not a page for anything to back. Dressing
 *    it in "4 claims · 2 sources" would make the one hit on this screen that
 *    carries no verdict look like the best-evidenced thing on it, which is the
 *    exact confusion the two-section split exists to prevent. The gate is here
 *    rather than left to the server's discretion because it is the console's own
 *    guarantee, and a guarantee nothing enforces is a hope.
 *  - **A `claim` hit is not a page either, and its silence is NOT an unmeasured
 *    value.** The response carries `evidence` on concept hits; a claim hit is
 *    one sentence from a page, not the page. Printing the em dash there would
 *    report a gap in the answer that is not one — the counts were never in
 *    scope, not missing — and CUI-SEV-2 is about keeping "not measured" meaning
 *    exactly that. The card already says "A claim on this page" and links to the
 *    page, where the full evidence lives.
 */
function isPageHit(hit: EvidenceBearingHit): boolean {
  return hit.tier === 'approved' && hit.kind === 'concept'
}

/**
 * How the archive backs the page behind one hit — or `null` where that question
 * has no answer, which is two thirds of the hits this page draws.
 *
 * The numbers themselves are NOT read here, and neither is the reason there are
 * none. `pageEvidence` in `page.logic` owns what `claims`, `uncited_claims` and
 * `sources` mean, what `not_measured` means, which shape each renders as and
 * which of them is allowed a token; a second, subtly different reading of the
 * same objects on a second screen would be worse than showing nothing. This
 * function decides ONE thing: whether the hit in front of it is a page
 * (`isPageHit`).
 *
 * It used to decide a second thing, and losing it is the change. A hit could
 * arrive bare for two reasons that looked identical in the hit, so this module
 * carried a `responseMeasured` flag that a caller derived by asking whether any
 * OTHER hit in the response had counts — a client deducing a property of a page
 * from the cards beside it. The server says it now, on the hit, in the same
 * object the index row carries, so the flag, the discriminator behind it and the
 * prop that threaded it down the tree are all gone. One argument, one owner, and
 * the two surfaces cannot drift because neither of them decides anything.
 */
export function hitEvidence(hit: EvidenceBearingHit): PageEvidence | null {
  if (!isPageHit(hit)) return null
  return pageEvidence(hit.evidence, hit.not_measured)
}
