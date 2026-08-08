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
 */
export function stagingDigest(space: string, draft: PageDraft): string {
  return ['wikikit-cockpit/page/v1', space, draft.slug, draft.title.trim(), draft.summary.trim(), draft.markdown].join(
    '\u0000',
  )
}

export function proposalInputHash(space: string, draft: PageDraft): string {
  return sha256Hex(stagingDigest(space, draft))
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
    input_hash: proposalInputHash(space, draft),
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
