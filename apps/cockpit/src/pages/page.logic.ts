import { STATUS_STATE, type DomainState } from '@/lib/tokens'

/**
 * The rules behind the page surface — the index, the document and the editor —
 * with no DOM attached.
 *
 * Two of them are load-bearing enough to justify this file on their own.
 *
 * The first is `conceptProposalBody`. Editing a page in this console does not
 * write a page: it stages a CHANGE PROPOSAL that a human has to approve, and the
 * body of that request is the single most consequential object the console
 * builds. An invented field is a 400 the operator reads as "the editor is
 * broken"; a MISSING field is worse, because `base_revision_id` decides whether
 * a reviewer is told the page moved underneath the author. The shape here is the
 * one `zCreateProposalArgs` in src/domain/proposals.ts validates, and it is
 * built in a pure function so a test can hold it byte for byte without a
 * renderer, a router or a network.
 *
 * The second is `sha256Hex`, and it is here rather than in `crypto.subtle` for a
 * deployment reason: WikiKit serves this console from the binary itself, over
 * whatever scheme the operator put it behind. `crypto.subtle` is undefined
 * outside a secure context, so on a plain-HTTP install on a LAN address the
 * digest would be unavailable — and `input_hash` is REQUIRED by the staging
 * schema, so the whole editor would fail to submit on exactly the installs least
 * likely to have anyone around to diagnose it. A hand-rolled SHA-256 has no such
 * dependency, and unlike a cheap 64-hex mixer it cannot collide: a collision
 * here does not corrupt anything, it silently returns SOMEBODY ELSE'S pending
 * proposal (the server dedups on `input_hash`) and the operator's edit is
 * quietly gone.
 */

/** The tones `Badge` accepts, restated so this module stays free of JSX. */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'unknown'

/**
 * Domain state → badge tone.
 *
 * Deliberately not derived from `STATE_TOKEN`: that table maps a state onto a
 * CSS custom property because an SVG stroke needs a colour, and `Badge` takes a
 * smaller vocabulary in which `muted-foreground` is not a member and
 * `destructive` is spelled `danger`.
 */
const BADGE_TONE: Record<DomainState, Tone> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
}

export function toneFor(state: DomainState): Tone {
  return BADGE_TONE[state]
}

/** A domain status word, with the tone the console reads it in. */
export function statusBadge(status: string): { label: string; tone: Tone } {
  return { label: status.replace(/_/g, ' '), tone: toneFor(STATUS_STATE[status] ?? 'unknown') }
}

/* ----------------------------------------------------------------- the index */

/**
 * "Changed within", as a closed alphabet.
 *
 * `/v1/spaces/{space}/concepts` takes no filter at all — only `limit` and the
 * keyset cursor — so this narrowing happens in the console, over the rows one
 * request answered. That is honest exactly as far as the read reaches, which is
 * why the index asks for the server's maximum (200) and prints the ceiling
 * beside the count rather than pretending the window covers a wiki that holds
 * more.
 */
export const CHANGE_WINDOWS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90 }

export const CHANGE_WINDOW_LABEL: Readonly<Record<string, string>> = {
  any: 'Any time',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whether a page changed inside the chosen window.
 *
 * An unrecognised window narrows nothing — a hand-edited or stale link shows the
 * whole list rather than an empty one. A row with no usable `updated_at` is
 * excluded from a time window and only from a time window: a filter that claims
 * "changed in the last 7 days" cannot honestly include a row nobody dated, and
 * the unfiltered list still shows it.
 */
export function changedWithin(updatedAt: string | null | undefined, window: string, now: number): boolean {
  const days = CHANGE_WINDOWS[window]
  if (days === undefined) return true
  if (!updatedAt) return false
  const at = new Date(updatedAt).valueOf()
  if (Number.isNaN(at)) return false
  return now - at <= days * DAY_MS
}

/* ------------------------------------------------------- the index's evidence */

/**
 * How well the archive backs one row of the pages list.
 *
 * Five states, and the two that print nothing are the ones every dashboard
 * drops. `unmeasured` is NOT `none`: the counts arrive with the list read, so a
 * console talking to a binary that predates them — a tab left open across a
 * rolling upgrade, a request that landed on the instance not yet replaced —
 * gets rows carrying no `evidence` object at all. "The server did not say" and
 * "the server said zero" are different facts about the world, and CUI-SEV-2
 * exists because a surface that prints `0` for the first one invents a
 * measurement (see the em dash in the cell, and `compareNumber`, which refuses
 * to sort an unmeasured value as though it were zero).
 *
 * `reference` is the second absence, and it is a fact about the PAGE rather
 * than about the response. The server withholds `evidence` for a reference
 * target — a row an import created so that reviewed relations had somewhere to
 * land, whose own body says in one sentence that the knowledge lives on the
 * pages it points at. There is no measurement to report, not a missing one, and
 * the distinction is the whole reason the field became optional: three zeros
 * there are the same three numbers a knowledge page that genuinely rests on
 * nothing carries, and an index where half the rows carry a meaningless zero
 * teaches its reader to ignore the ones that mean something. It splits off
 * `unmeasured` for the same reason `unmeasured` split off `none` — both render
 * as the dash, and a reader who is shown a dash is owed the reason for it.
 *
 * `none` covers the page nobody has evidenced yet — a page written by hand
 * through the console carries zero claims, and until now no list said so. It
 * folds into no other state: it is not `partial` (there is nothing to be
 * partial about) and it is emphatically not `backed`.
 *
 * A page whose claims are ALL uncited is `partial` rather than a state of its
 * own, because the cell says "12 claims" beside "12 uncited" and those two
 * numbers are more precise than any word a level name could carry.
 */
export type EvidenceLevel = 'unmeasured' | 'reference' | 'none' | 'partial' | 'backed'

/**
 * The two levels that have no number to print, so the cell draws the em dash.
 *
 * A predicate rather than an equality test at each call site: `unmeasured` was
 * the only wordless state for two releases and every surface that draws this
 * object checked for it by name, so adding a second one silently sent a
 * reference target down the branch that prints a count — a row reading
 * "Evidence:" followed by nothing. One name, and a surface that forgets to
 * handle a level added later fails in one place instead of rendering an empty
 * cell in three.
 */
export function rendersAsDash(level: EvidenceLevel): boolean {
  return level === 'unmeasured' || level === 'reference'
}

/**
 * The `evidence` object one row of `GET /v1/spaces/{space}/concepts` carries.
 *
 * The server declares all three as required non-negative integers WHERE THE
 * OBJECT IS SERVED — it omits the object itself for a reference target rather
 * than nulling its fields, because a null field would invite exactly the `?? 0`
 * this file spends three functions refusing. The three are optional and
 * nullable HERE and only here, because this shape's job is to describe what the
 * console might actually receive, which includes a response from a deployment
 * that has never heard of them and a half-filled object from one that is wrong
 * about itself (see `pageEvidence`).
 *
 * `claims` counts VISIBLE claims only (`verified | disputed | deprecated`);
 * `proposed` and `draft` belong to a pending proposal rather than to the page,
 * and counting them would let an unreviewed change make a page look evidenced.
 * `sources` is BREADTH — distinct sources — and is emphatically not
 * `claims - uncited_claims`: five claims quoting one document and five claims
 * quoting five are the same number of cited claims and not the same knowledge.
 */
export interface EvidenceCounts {
  claims?: number | null
  uncited_claims?: number | null
  sources?: number | null
}

export interface PageEvidence {
  level: EvidenceLevel
  /** The claim count as printed, or null where there is no count to print. */
  count: string | null
  /** The exception worth a badge, or null when the row has nothing to flag. */
  flag: string | null
  /** The `flag`'s tone. `unknown` where there is no flag, so a caller cannot paint one. */
  tone: Tone
  /** What backs it, in sources. Null when the server did not count them. */
  detail: string | null
  /** The whole state as one sentence — the cell's `title`, and its only text when unmeasured. */
  reading: string
  /** Ascending order = least-backed first. Null is unmeasured, never "worst". */
  rank: number | null
}

/**
 * A count the server actually sent, or null.
 *
 * A negative or fractional count is a server that is wrong about itself, and the
 * console reads that as "not measured" rather than rendering an impossible row:
 * `-1 claims` teaches an operator nothing and would sort between the pages
 * nothing backs and the pages something does.
 */
function measuredCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || !Number.isInteger(value)) return null
  return value
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The sort key, alone, because the comparator runs O(n log n) times.
 *
 * Building a whole `PageEvidence` — four strings, one object — inside a
 * comparator over two hundred rows allocates a few thousand objects for every
 * click on the header, so the ordering rule is extracted and `pageEvidence`
 * calls it rather than the other way round.
 *
 * The key is the SHARE of a page's claims that carry a quote, not the number of
 * them: the column answers "is this page's evidence complete", so a page with
 * three claims and three quotes ranks above one with two hundred claims and one
 * missing quote. Volume is not the question — a wiki is not better because a
 * page asserts more.
 *
 * A page with no claims ranks 0, alongside a page whose every claim is uncited,
 * and that is deliberate: in both, nothing in the archive backs a word of it.
 * Unmeasured is `null` and NOT 0 — `compareNumber` puts unmeasured below every
 * measured value, which is the console's one rule for blanks everywhere. In
 * practice the two never mix: the counts come from one response, so either every
 * row has them or none does.
 */
export function evidenceRank(counts: EvidenceCounts | null | undefined): number | null {
  const claims = measuredCount(counts?.claims)
  const uncited = measuredCount(counts?.uncited_claims)
  if (claims === null || uncited === null) return null
  if (claims === 0) return 0
  return (claims - Math.min(uncited, claims)) / claims
}

/**
 * Did this response measure evidence AT ALL?
 *
 * The two reasons a row can arrive without counts look identical in the row —
 * the object is simply not there — and they call for opposite sentences. One is
 * a fact about the PAGE ("a reference target holds no knowledge to measure"),
 * the other a fact about the RESPONSE ("this build does not report counts"), and
 * telling a reader the first one when the second is true would be the console
 * inventing a property of a page it knows nothing about.
 *
 * The discriminator is the rest of the list. A response that measured ANY page
 * comes from a build that measures, so a row in it that carries nothing is a row
 * the server declined to measure — a reference target. A response where not one
 * row carries counts is a build that does not report them, and no row in it may
 * be described as a reference target.
 *
 * The one case this cannot separate is a wiki whose every loaded page is a
 * reference target: no row measures, so every row falls to `unmeasured`. That
 * is the deliberate direction to be wrong in — the fallback sentence ("this list
 * came back without evidence counts") is still TRUE of such a response, merely
 * less specific, whereas the reference-target sentence asserted about an old
 * build would be false about every page in the wiki.
 *
 * Read over the WHOLE response and never over the rows a filter left behind: a
 * "changed in the last 7 days" window that happens to keep only reference
 * targets would otherwise flip every one of them to the vaguer sentence, and a
 * filter must not change what a page IS.
 */
export function listMeasuresEvidence(rows: readonly { evidence?: EvidenceCounts | null }[]): boolean {
  // `evidenceRank` and not a property check: a row carrying `{claims: -1}` is a
  // server contradicting itself, and `pageEvidence` reads it as unmeasured. If
  // that row were allowed to vouch for the response, a whole list of them would
  // vouch for a build that measures nothing.
  return rows.some((row) => evidenceRank(row.evidence) !== null)
}

/**
 * One row's evidence, ready to render.
 *
 * The tone is the decision worth defending, and only two states get one at all:
 *
 *  - **`backed` wears no badge, and certainly not a green one.** Every claim
 *    quoting a source is this product's baseline promise, not an achievement; a
 *    `success` pill on two thirds of a list stops meaning anything by the third
 *    row, and it is exactly the token CUI-AI-1 forbids putting anywhere near
 *    "how does the wiki know this". The plain count IS the statement — the same
 *    refusal `evidenceOf` already makes for a single cited claim.
 *  - **`partial` is `warning`** — `STATE_TOKEN`'s `blocked`, "stopped until a
 *    human acts", which is literally the state: those claims stay unbacked until
 *    somebody finds the quote or withdraws them.
 *  - **`none` is `warning` too, and the alternatives were both wrong.**
 *    `success` is forbidden outright: a page nothing backs must never wear a
 *    token that reads as verified (CUI-AI-1, CUI-SEV-1). `danger` overstates it
 *    — nobody erred, a hand-written page legitimately starts with no claims and
 *    the operator who wrote it did exactly what the editor invited. And
 *    `unknown` — the muted dashed pill — is the trap: that is this console's
 *    word for "not measured", and the very same column needs it for the row
 *    whose counts never arrived. Spending it on a measured zero as well would
 *    collapse the one distinction CUI-SEV-2 is about, in the one place the
 *    product cannot afford to lose it.
 *
 * `none` and `partial` therefore share a colour, and the CELL is what separates
 * them: `partial` prints a claim count with the amber flag beside it as the
 * exception, `none` prints the flag and no count at all, `backed` prints a count
 * and no flag. Three shapes, three readings, and a word on every one of them
 * because colour alone says nothing (CUI-A11Y-5).
 *
 * `listMeasured` is the second argument because absence alone does not say WHY,
 * and a dash whose reason nobody can get at is only marginally better than a
 * wrong zero — the reader still has to go and ask the linter, which is the round
 * trip this change exists to end. It defaults to `false`, the reading that
 * claims the least: a caller that has not established the response measures
 * anything gets "the counts did not arrive", which is true of every absence.
 * Only a caller holding the whole response can say more (`listMeasuresEvidence`).
 */
export function pageEvidence(counts: EvidenceCounts | null | undefined, listMeasured = false): PageEvidence {
  const claims = measuredCount(counts?.claims)
  const uncited = measuredCount(counts?.uncited_claims)
  const rank = evidenceRank(counts)

  if (claims === null || uncited === null)
    return {
      level: listMeasured ? 'reference' : 'unmeasured',
      count: null,
      flag: null,
      tone: 'unknown',
      detail: null,
      // Two absences, two sentences, and neither of them is a number. The
      // reference-target reading says what the page IS, because that is the
      // question an operator staring at a dash actually has and the answer is
      // not "wait for the next release" — nothing here is pending, nothing is
      // broken, and there is no ingest to run. The page is furniture holding a
      // reviewed relation, and the knowledge it points at is on the pages it
      // links to.
      reading: listMeasured
        ? 'This page is a reference target for relations, not a knowledge page, so evidence is not measured for it.'
        : 'This list came back without evidence counts, so how well this page is backed is not known here.',
      rank,
    }

  // Clamped rather than trusted: more uncited claims than claims is a server
  // that contradicts itself, and "13 of 12" is a row an operator would rightly
  // stop believing. The clamp reads as "all of them", which is the worst case
  // either number could mean.
  const missing = Math.min(uncited, claims)
  const sources = measuredCount(counts?.sources)
  // A page with no claims necessarily has no sources, so "0 sources" beside "No
  // claims" is the same fact twice. Everywhere else the count is printed even at
  // zero, because a measured zero is a fact (CUI-SEV-2).
  const detail = sources === null || claims === 0 ? null : plural(sources, 'source', 'sources')
  const backing = detail ? `, backed by ${detail}` : ''

  if (claims === 0)
    return {
      level: 'none',
      count: null,
      flag: 'No claims',
      tone: 'warning',
      detail: null,
      reading: 'This page makes no claims yet, so nothing in the archive backs it.',
      rank,
    }

  const count = plural(claims, 'claim', 'claims')

  if (missing === 0)
    return {
      level: 'backed',
      count,
      flag: null,
      tone: 'unknown',
      detail,
      reading: `${count}, every one quoting a source${backing}.`,
      rank,
    }

  return {
    level: 'partial',
    count,
    flag: `${missing} uncited`,
    tone: 'warning',
    detail,
    reading: `${count}, ${missing} of them with no quote behind it${backing}.`,
    rank,
  }
}

/* ---------------------------------------------------------------- the claims */

/** The part of a claim this module decides on. The wire carries more. */
export interface ClaimLike {
  subject: string
  predicate: string
  object: string
  citations: readonly unknown[]
}

/** A claim is a triple, and a reader reads it as a sentence. */
export function claimSentence(claim: Pick<ClaimLike, 'subject' | 'predicate' | 'object'>): string {
  return [claim.subject, claim.predicate.replace(/_/g, ' '), claim.object].join(' ')
}

export interface Evidence {
  quotes: number
  cited: boolean
  label: string
  tone: Tone
}

/**
 * How well a claim is evidenced — the one fact this product exists to show.
 *
 * A claim with no citation is not a neutral claim: WikiKit's whole promise is
 * that every claim carries a verbatim quote from an archived source, so an
 * uncited one is a defect in the knowledge and wears `danger`. A cited one gets
 * a plain count in `neutral`, NOT a second green badge — the claim's status
 * badge beside it already carries the verdict, and two greens on one row make
 * "verified" and "has three quotes" look like one fact.
 */
export function evidenceOf(quotes: number): Evidence {
  if (!Number.isFinite(quotes) || quotes <= 0) return { quotes: 0, cited: false, label: 'No quote', tone: 'danger' }
  return { quotes, cited: true, label: quotes === 1 ? '1 quote' : `${quotes} quotes`, tone: 'neutral' }
}

/**
 * The sentence above the claims panel.
 *
 * Uncited claims are counted and named because a page whose claims nobody can
 * check is the failure mode this console is for. Zero claims is its own
 * sentence: a page with no claims is not a well-evidenced page, it is a page
 * that asserts nothing structured yet.
 */
export function evidenceSummary(claims: readonly ClaimLike[]): string {
  if (claims.length === 0) return 'No claims on this page yet.'
  const uncited = claims.filter((claim) => claim.citations.length === 0).length
  const total = `${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}`
  if (uncited === 0) return `${total}, every one quoting a source.`
  return `${total}, ${uncited} of them with no quote behind it.`
}

/* -------------------------------------------------------------- the revisions */

/** The part of a revision row this module decides on. */
export interface RevisionLike {
  id: string
  rev: number
  status: string
}

/**
 * Which revision the editor is writing against.
 *
 * This is the stale-base anchor (§1.9), and getting it right is what makes a
 * reviewer see `stale: true` instead of silently losing somebody's approval. The
 * concept read carries `rev` but not the revision's id, so the id comes from the
 * history read; `current` is the pointer, and the highest `rev` breaks a tie
 * that should not exist but must not be resolved arbitrarily.
 *
 * `null` means "the console could not establish one", which is a different
 * instruction to the server than `null` on the wire — see `conceptProposalBody`.
 */
export function currentRevisionId(revisions: readonly RevisionLike[]): string | null {
  let best: RevisionLike | null = null
  for (const revision of revisions) {
    if (revision.status !== 'current') continue
    if (!best || revision.rev > best.rev) best = revision
  }
  return best?.id ?? null
}

/* ----------------------------------------------------------------- the editor */

/** What the editor holds while somebody is typing. */
export interface PageDraft {
  slug: string
  title: string
  summary: string
  markdown: string
}

export const EMPTY_DRAFT: PageDraft = { slug: '', title: '', summary: '', markdown: '' }

/** The server's own concept-slug alphabet — `CONCEPT_SLUG` in src/http/schemas.ts. */
export const CONCEPT_SLUG = /^[a-z0-9][a-z0-9-]{0,126}$/

/**
 * A title, as an address.
 *
 * Only a suggestion: the field stays editable, because a slug is what every link
 * to this page will use forever and the person writing the page is the one who
 * should decide it. Diacritics are decomposed rather than dropped so "Größe"
 * becomes `grosse`-shaped rather than `gr-e`.
 */
export function slugify(title: string): string {
  return (
    title
      .replace(/ß/g, 'ss')
      .normalize('NFKD')
      // The combining marks NFKD just split off. Dropping them rather than the
      // letters they sat on is the whole reason for normalising first: "Größe"
      // becomes `grosse`, not `gr-e`.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 127)
      .replace(/-+$/, '')
  )
}

/**
 * Why a draft cannot be submitted yet, in the author's words — or null when it
 * can.
 *
 * One function rather than a chain of `disabled={...}` expressions, so the
 * button's disabled state and the reason a reader is shown can never disagree,
 * and so the rule is testable without a form.
 */
export function draftProblem(draft: PageDraft, isNew: boolean): string | null {
  if (draft.title.trim().length === 0) return 'A page needs a title.'
  if (isNew) {
    if (draft.slug.length === 0) return 'A page needs an address — every link to it will use the slug.'
    if (!CONCEPT_SLUG.test(draft.slug))
      return 'A slug is lower-case letters, digits and hyphens, starting with a letter or a digit.'
  }
  if (draft.markdown.trim().length === 0) return 'A page with no text stages nothing to review.'
  return null
}

/** The title the review queue will show this change under. */
export function proposalTitle(draft: PageDraft, isNew: boolean): string {
  const title = draft.title.trim() || draft.slug
  return (isNew ? `New page: ${title}` : `Update ${title}`).slice(0, 500)
}

/**
 * The bytes the dedup anchor is taken over.
 *
 * `input_hash`'s documented recipe (sorted source hashes + a prompt version)
 * describes an ingest, and a hand-written page has no sources and no prompt — so
 * the console hashes the thing it actually staged. That keeps the server's
 * idempotency promise pointing the right way: pressing Submit twice on the same
 * text converges on the ONE pending change instead of putting two identical
 * items in somebody's review queue, and changing a single character stages a new
 * one.
 *
 * NUL separates the fields because it is the one character a Markdown editor
 * cannot produce, so no title can be crafted to collide with a markdown body.
 * The leading tag namespaces cockpit hashes away from the pipeline's.
 *
 * The BASE REVISION is one of those fields, and it is the field the first
 * version of this digest was missing. The text is not the whole of what was
 * staged: the same paragraph written against revision 7 and against revision 8
 * are two different proposals, because a reviewer reads the second one against a
 * page that has moved underneath it. Without the base in here, an author whose
 * page was approved out from under them re-submits and the server's pending
 * dedup (`createProposal`, src/domain/proposals.ts) hands back the OLD proposal
 * — the one anchored to the revision that is now stale. They do land on a change
 * page that says the merge will most likely fail, so nobody is misled, but there
 * is no way to stage a fresh one except by altering a byte of their own prose,
 * and "type a space to make the button work" is not an instruction a product may
 * need.
 *
 * The tag says `v2` because the field list changed, and the version in the tag
 * IS the field list: two different lists under one name would make the namespace
 * a lie. Nothing persists a cockpit digest, so the only consequence of the bump
 * is that a proposal staged by an older console and still pending across the
 * upgrade does not dedup against a re-submission — once, and it converges again
 * from there.
 */
export function stagingDigest(space: string, draft: PageDraft, baseRevisionId: string | null | undefined): string {
  // Spelled with a prefix rather than dropped in raw so the three states stay
  // readable in the digest itself: an id, `none` (a new page, written against
  // no revision), `unresolved` (the history read failed, so the server will
  // fall back to its own pointer). `unresolved` is the one case where two
  // submissions can still converge on a base that moved between them — the
  // console cannot hash an anchor it never learned. That is the same exposure
  // this whole field closes, now confined to the read-failure path instead of
  // being the normal case.
  const base =
    baseRevisionId === undefined ? 'base:unresolved' : baseRevisionId === null ? 'base:none' : `base:${baseRevisionId}`
  return [
    'wikikit-cockpit/page/v2',
    space,
    draft.slug,
    draft.title.trim(),
    draft.summary.trim(),
    base,
    draft.markdown,
  ].join('\u0000')
}

export function proposalInputHash(space: string, draft: PageDraft, baseRevisionId: string | null | undefined): string {
  return sha256Hex(stagingDigest(space, draft, baseRevisionId))
}

/**
 * The staging request, exactly as `zCreateProposalArgs` validates it.
 *
 * Three decisions the schema forced, each of them invisible in the rendered
 * form:
 *
 *  - **No `agent_meta`.** `createProposalHandler` stamps `MANUAL_AGENT_META`
 *    when the body carries none (§1.14), and that stamp is the truth: a human
 *    typed this. Sending our own would be the console inventing a provenance.
 *  - **No claims and no relations.** A claim is only a claim if it carries a
 *    verbatim quote from an ARCHIVED source, and a textarea cannot produce one.
 *    Staging empty claims would manufacture exactly the uncited assertions the
 *    lint exists to find. Claims arrive by ingesting sources; the editor writes
 *    prose.
 *  - **`base_revision_id` is present-and-null, present-with-an-id, or absent,
 *    and the three mean different things.** `null` says "written against no
 *    revision", which is the truth for a new page. An id is the anchor that
 *    makes a concurrent approval visible to the reviewer as a stale base instead
 *    of a silent overwrite. Absent tells the server to fall back to whatever the
 *    pointer is at staging time — acceptable only when the console could not
 *    establish the id (the history read failed), and never the default, because
 *    an editor left open for ten minutes is exactly the window that fallback
 *    was not written for.
 */
export function conceptProposalBody(args: {
  space: string
  draft: PageDraft
  isNew: boolean
  /** `null` for a new page, an id for an edit, `undefined` when it could not be established. */
  baseRevisionId: string | null | undefined
}): Record<string, unknown> {
  const { space, draft, isNew, baseRevisionId } = args
  const title = draft.title.trim()
  const summary = draft.summary.trim()
  const concept: Record<string, unknown> = {
    slug: draft.slug,
    title,
    summary,
    markdown: draft.markdown,
    claims: [],
    relations: [],
  }
  const base = isNew ? null : baseRevisionId
  if (base !== undefined) concept.base_revision_id = base

  return {
    title: proposalTitle(draft, isNew),
    summary,
    // The EFFECTIVE base — the one this body actually carries, after `isNew`
    // has forced it to null — and not the caller's argument: the dedup anchor
    // has to describe the request that was sent, or two bodies that differ in
    // the field a reviewer reads would hash the same.
    input_hash: proposalInputHash(space, draft, base),
    source_ids: [],
    concepts: [concept],
  }
}

/* ------------------------------------------------------------------- sha-256 */

const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

/**
 * SHA-256 of a UTF-8 string, lower-case hex.
 *
 * Straight FIPS 180-4, and deliberately synchronous: `crypto.subtle.digest` is
 * a promise and is missing entirely outside a secure context, which a
 * self-hosted console on plain HTTP is. Every intermediate is forced back into
 * an unsigned 32-bit word with `>>> 0`, because JavaScript's bitwise operators
 * hand back signed integers and a single missing coercion is a digest that is
 * wrong only sometimes.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const bitLength = bytes.length * 8
  // The message, a 0x80 terminator, zeroes, and the length in bits in the last
  // eight bytes — so the padded form is the first multiple of 64 with room for
  // both the terminator and the length.
  const blocks = Math.floor((bytes.length + 8) / 64) + 1
  const padded = new Uint8Array(blocks * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array<number>(64).fill(0)

  for (let block = 0; block < blocks; block += 1) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(block * 64 + index * 4)
    for (let index = 16; index < 64; index += 1) {
      const x = w[index - 15]!
      const y = w[index - 2]!
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0
    }

    let a = h[0]!
    let b = h[1]!
    let c = h[2]!
    let d = h[3]!
    let e = h[4]!
    let f = h[5]!
    let g = h[6]!
    let acc = h[7]!

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const choice = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (acc + sigma1 + choice + K[index]! + w[index]!) >>> 0
      const sigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (sigma0 + majority) >>> 0
      acc = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    const round = [a, b, c, d, e, f, g, acc]
    for (let index = 0; index < 8; index += 1) h[index] = (h[index]! + round[index]!) >>> 0
  }

  return h.map((word) => word.toString(16).padStart(8, '0')).join('')
}
