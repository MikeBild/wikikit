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
import { listMeasuresEvidence, pageEvidence, type EvidenceCounts, type PageEvidence } from '@/pages/page.logic'

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
}

/**
 * Which hits are PAGES — the only hits an evidence summary belongs on.
 *
 * Two callers now depend on this being one answer rather than two: the reading
 * of a single hit, and the reading of the whole response that tells one absence
 * from the other. If they ever disagreed, a response could be judged "measures
 * evidence" on the strength of a hit whose evidence the console then refuses to
 * read, which is a discriminator vouching for something it does not believe.
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
 * Did THIS RESPONSE measure evidence at all?
 *
 * The pages index answers the same question with `listMeasuresEvidence`, and for
 * the same reason: a concept hit can arrive without counts for two reasons that
 * look identical in the hit and call for opposite sentences. One is a fact about
 * the PAGE — the server declines to measure a reference target, a row an import
 * created so reviewed relations had somewhere to land, whose own body says the
 * knowledge lives on the pages it points at. The other is a fact about the
 * RESPONSE — a build that predates the counts, reached by a tab that outlived a
 * rolling upgrade, which reports them on nothing.
 *
 * The discriminator is the rest of the response, and it needs no new field: a
 * response in which SOME concept hit carries counts came from a build that
 * measures, so a bare concept hit beside it is one the server declined to
 * measure. A response where not one concept hit carries them is the old build,
 * and no hit in it may be called a reference target.
 *
 * Only page hits are consulted, because only page hits are ever measured. A
 * claim hit and a source-evidence hit carry nothing BY DESIGN (`isPageHit`), so
 * counting them could only ever drag the answer toward "this build does not
 * measure" — a search filtered to `kind=claim` would otherwise look like an old
 * server. And the day a server started attaching counts to a claim hit, letting
 * that vouch for the build would be this module trusting a number it refuses to
 * render two lines further down.
 *
 * The one case this cannot separate is a response whose every page hit is a
 * reference target: nothing measures, so every one of them falls back to the
 * vaguer reading. That is the deliberate direction to be wrong in — "this search
 * came back without evidence counts" is still TRUE of such a response, merely
 * less specific, whereas the reference-target sentence asserted about an old
 * build would be false about every page on the screen.
 *
 * Read over the WHOLE response and never over the section a card sits in: the
 * two tiers are one answer split into two lists for the reader, and a page hit
 * must not change what it says about itself because of where it was drawn.
 */
export function searchMeasuresEvidence(hits: readonly EvidenceBearingHit[]): boolean {
  return listMeasuresEvidence(hits.filter(isPageHit))
}

/**
 * How the archive backs the page behind one hit — or `null` where that question
 * has no answer, which is two thirds of the hits this page draws.
 *
 * The numbers themselves are NOT read here. `pageEvidence` in `page.logic` owns
 * what `claims`, `uncited_claims` and `sources` mean, which shape they render
 * as, and which of them is allowed a token; 0.25.0 settled all of that one
 * surface earlier and a second, subtly different reading of the same three
 * integers on a second screen would be worse than showing nothing. This
 * function decides two things only: whether the hit in front of it is a page
 * (`isPageHit`), and which of the two absences a bare page hit is.
 *
 * `responseMeasured` is that second decision, and it is a parameter rather than
 * a default because a hit cannot answer it alone — see `searchMeasuresEvidence`,
 * which is what a caller holding the whole response calls to get it. It defaults
 * to `false`, the reading that claims the least: a caller that has not
 * established the response measures anything gets "the counts did not arrive",
 * which is true of every absence. Until this release there was no parameter at
 * all and every dash on this screen said that sentence — including the ones on
 * reference targets in a response whose other hits carried counts, where it was
 * flatly false, on the surface belonging to the release whose whole thesis was
 * that a screen must not say something untrue about a page.
 */
export function hitEvidence(hit: EvidenceBearingHit, responseMeasured = false): PageEvidence | null {
  if (!isPageHit(hit)) return null
  return pageEvidence(hit.evidence, responseMeasured)
}
