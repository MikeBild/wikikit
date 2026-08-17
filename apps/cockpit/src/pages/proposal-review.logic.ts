/**
 * Everything the proposal review surface DECIDES, with nothing it draws.
 *
 * Reviewing is the act this product exists for, and almost none of what makes a
 * review trustworthy is a pixel: which lines actually changed, whether a
 * document is too big to diff at all, what approval will publish, and — the one
 * a queue gets wrong most often — how a change that a reviewer already sent back
 * differs from one nobody has opened. Those are rules, and a rule that needs a
 * browser to prove it is a rule nobody proves.
 *
 * One constraint shapes this file, and it is inherited rather than chosen:
 * **no DOM types.** The unit runner compiles `test/` with `lib: ES2023` and no
 * `DOM` (the server is the product; the console is a guest here), so nothing
 * below may touch a document, an element or a browser global. `Uint32Array` is
 * ES2015 and is fine.
 *
 * There is no second one, though this comment long claimed the `@/*` alias
 * was: the root tsconfig maps it onto `apps/cockpit/src` so the tests can
 * import these modules by the console's own path. The relative `../lib/tokens.ts`
 * below is therefore a spelling, not a workaround — and the spelling is not
 * what keeps this file testable. What an import DRAGS IN is: the no-DOM rule
 * is transitive, and it is broken two files down or not at all.
 */

import { CHANGES_REQUESTED_STATE, SEVERITY_STATE, STATUS_STATE, type DomainState } from '../lib/tokens.ts'

/* --------------------------------------------------------------- line diff */

/** One rendered line: `' '` context, `'-'` removed, `'+'` added. */
export interface DiffLine {
  op: ' ' | '-' | '+'
  text: string
}

/**
 * Dependency-free line diff (classic LCS backtrack).
 *
 * This is a PORT, not a rewrite. `src/http/review-page.ts` holds the original —
 * it is stringified verbatim into the public review page's inline script and a
 * test pins its bytes, so it cannot be imported (it would drag the server's
 * module graph into the browser bundle) and it cannot be changed. Copying the
 * approach instead of inventing a second one is the point: the reviewer who
 * opens `/review/<id>` on their phone and the reviewer who opens this console
 * must see the same lines marked the same way, or the two surfaces disagree
 * about what a change even is.
 *
 * Returns `null` when the inputs exceed the size guard — ~3000 lines either side
 * or ~4M table cells. An LCS table is O(n·m) in both time and memory, so a
 * pathological pair does not render slowly, it freezes the tab; the caller falls
 * back to side-by-side text. The literals are inline, as in the original.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] | null {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length > 3000 || b.length > 3000 || a.length * b.length > 4000000) return null
  const width = b.length + 1
  // Uint32 LCS table, flat for memory locality.
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] ?? '' })
      i++
      j++
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push({ op: '-', text: a[i] ?? '' })
      i++
    } else {
      out.push({ op: '+', text: b[j] ?? '' })
      j++
    }
  }
  while (i < a.length) out.push({ op: '-', text: a[i++] ?? '' })
  while (j < b.length) out.push({ op: '+', text: b[j++] ?? '' })
  return out
}

/** The staged page, reduced to what a diff is computed from. */
export interface StagedConcept {
  is_new: boolean
  old_markdown: string | null
  new_markdown: string
}

/**
 * What to draw for one page in the change.
 *
 * `'lines'` carries the diff plus its two counts; `'too-large'` carries the raw
 * documents for the fallback. A brand-new page has no base to compare against,
 * so every line is an addition — the same reading the review page uses, and the
 * reason `created` is a flag on `'lines'` rather than a third case: the markup
 * is identical, only the sentence above it differs.
 */
export type ConceptDiff =
  | { kind: 'lines'; created: boolean; lines: DiffLine[]; added: number; removed: number }
  | { kind: 'too-large'; before: string; after: string }

export function conceptDiff(concept: StagedConcept): ConceptDiff {
  // `is_new` and a null base are the same fact from two directions, and both
  // occur: a page created by this change, and a page whose base revision the
  // server could not resolve. Either way there is nothing to subtract from.
  const before = concept.is_new ? null : concept.old_markdown
  if (before === null || before === undefined) {
    const lines = concept.new_markdown.split('\n').map<DiffLine>((text) => ({ op: '+', text }))
    return { kind: 'lines', created: true, lines, added: lines.length, removed: 0 }
  }
  const lines = lineDiff(before, concept.new_markdown)
  if (!lines) return { kind: 'too-large', before, after: concept.new_markdown }
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.op === '+') added++
    else if (line.op === '-') removed++
  }
  return { kind: 'lines', created: false, lines, added, removed }
}

/**
 * Whether a diff is worth calling a change at all.
 *
 * A re-synthesis that produced byte-identical markdown still arrives as a staged
 * concept, and printing an all-context diff under the heading "what changed"
 * invites a reviewer to approve something on the strength of a document they can
 * see is untouched. The claims and relations may still differ, which is why this
 * reports the markdown only.
 */
export function isMarkdownUnchanged(diff: ConceptDiff): boolean {
  return diff.kind === 'lines' && diff.added === 0 && diff.removed === 0
}

/* ------------------------------------------------------- status, in words */

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
  failed: 'Failed',
  split: 'Split',
}

/** The lifecycle word, the flag beside it, and the sentence that explains both. */
export interface ChangeReading {
  label: string
  state: DomainState
  /** Present only when the row carries `changes_requested`. */
  flag: { label: string; state: DomainState } | null
  /** What a reviewer should take from this state, when there is anything to take. */
  note: string | null
}

/**
 * How one change reads, from its status and its `changes_requested` flag.
 *
 * `changes_requested` is a BOOLEAN, never a sixth status, and migration 0020 is
 * explicit about why: request-changes is a TERMINAL reject plus a
 * machine-readable flag, because WikiKit has no rebase — acting on feedback is a
 * FRESH change, not an edit to this one. So the flag is carried alongside
 * `rejected` in practice and alongside `pending` in the schema, and both have to
 * read differently from the same status without it: "rejected" alone says the
 * answer was no and the matter is closed, when what actually happened is that
 * somebody read it and asked for a revision.
 *
 * That is what `CHANGES_REQUESTED_STATE` is for, and it is deliberately the same
 * `blocked` that `pending` wears — the flag is not a severity, it is "stopped
 * until a human acts". Colour therefore cannot carry it, and does not: the WORD
 * is the difference (CUI-A11Y-5), which is why the flag has a label of its own
 * rather than being a tint on the status badge.
 */
export function changeState(status: string, changesRequested: boolean): ChangeReading {
  const label = STATUS_LABEL[status] ?? status
  const state = STATUS_STATE[status] ?? 'unknown'
  const flag = changesRequested ? { label: 'Changes requested', state: CHANGES_REQUESTED_STATE } : null
  return { label, state, flag, note: noteFor(status, changesRequested) }
}

function noteFor(status: string, changesRequested: boolean): string | null {
  if (changesRequested)
    return 'A reviewer sent this back with a revision note. Acting on it means a fresh change — this one cannot be edited and re-submitted.'
  if (status === 'failed')
    return 'Approval was attempted and the pages underneath had already moved on. Re-ingesting the sources produces a fresh change against the current text.'
  if (status === 'split')
    return 'Its pages were dealt out into child changes. This one is terminal and can never move again.'
  if (status === 'pending') return null
  return null
}

/* ------------------------------------------------------- what approval does */

/** The staged content, reduced to what approval will actually do with it. */
export interface ApprovalScope {
  concepts: readonly {
    slug: string
    is_new: boolean
    stale: boolean
    claims: readonly { collides: boolean }[]
  }[]
  decisions: readonly unknown[]
  relations_removed: readonly unknown[]
}

/**
 * The exact effect of Approve, as sentences, for the confirmation's `details`.
 *
 * Every mutation with a consequence restates its effect before it happens, and
 * this is the one where the restatement matters most: approving is the moment
 * text becomes knowledge that agents will answer from. Counting is not enough —
 * a colliding claim marks BOTH sides disputed, and a removed relation is
 * deactivated on an existing page that this change never mentions. Those are the
 * consequences a reviewer cannot see from the diff, so they are the ones spelled
 * out.
 *
 * Returned as sentences rather than a record because the caller renders them as
 * a list and nothing else ever needs the numbers apart.
 */
export function approvalEffect(scope: ApprovalScope, space: string): string[] {
  const lines: string[] = []
  const pages = scope.concepts.length
  const created = scope.concepts.filter((concept) => concept.is_new).length
  const updated = pages - created
  if (pages > 0) {
    const shape =
      created > 0 && updated > 0 ? ` (${created} new, ${updated} updated)` : created > 0 ? ' (new)' : ' (updated)'
    lines.push(`Publishes ${count(pages, 'page')}${shape} into ${space}, visible to every reader and every agent.`)
  }
  if (scope.decisions.length > 0) lines.push(`Records ${count(scope.decisions.length, 'decision')} in the wiki's log.`)

  const collisions = scope.concepts.reduce(
    (total, concept) => total + concept.claims.filter((claim) => claim.collides).length,
    0,
  )
  if (collisions > 0)
    lines.push(
      `Marks ${count(collisions, 'claim')} disputed — each one contradicts a visible claim on the same frame, and approval disputes BOTH sides.`,
    )

  if (scope.relations_removed.length > 0)
    lines.push(`Deactivates ${count(scope.relations_removed.length, 'relation')} that other pages currently rely on.`)

  const stale = staleSlugs(scope.concepts)
  if (stale.length > 0)
    lines.push(
      `Will most likely FAIL: ${stale.join(', ')} moved on since this was written, and the server refuses a stale base.`,
    )

  // A removal-only change stages no pages at all, and a confirmation that says
  // nothing is a confirmation nobody reads.
  if (lines.length === 0) lines.push(`Records the decision against this change. Nothing is published into ${space}.`)
  return lines
}

/** The pages whose base revision moved on since this change was written. */
export function staleSlugs(concepts: readonly { slug: string; stale: boolean }[]): string[] {
  return concepts.filter((concept) => concept.stale).map((concept) => concept.slug)
}

/**
 * Whether one page can be lifted out of this change into its own.
 *
 * Only while the change is still pending, and only when there is more than one
 * page in it: deferring the sole page would move the whole change sideways into
 * a child and leave an empty parent, which is a split with extra steps and reads
 * to the operator as though nothing happened.
 */
export function isDeferable(status: string, conceptCount: number): boolean {
  return status === 'pending' && conceptCount > 1
}

/** The staged content, reduced to what a FULL split deals out. */
export interface SplitScope {
  /** The parent's title — the children are named after it, verbatim. */
  title: string
  concepts: readonly { slug: string }[]
  decisions: readonly unknown[]
  relations_removed: readonly { from_slug: string }[]
}

export interface SplitPlan {
  /** How many pending children a full split creates, the catch-all included. */
  children: number
  /**
   * The child that is not a page, when there is one: the title the server will
   * give it, and what it will be holding.
   */
  leftovers: { title: string; holds: string } | null
}

/**
 * What a full split will actually create — which is not always one child per page.
 *
 * `wk_split_proposal` (migration 0020) deals each staged concept into its own
 * pending child, and then, when anything staged would be left behind on a parent
 * that is about to go terminal, it creates ONE more child titled
 * `<parent title> — decisions` and moves that leftover into it. Two things end up
 * there: every staged decision, and every relation-removal marker whose
 * from-concept this change does not stage — the per-concept loop re-points only
 * the markers that leave a concept being split out, so a removal from a page this
 * change never touches has nowhere else to go.
 *
 * Counting `concepts.length` and calling it the answer is therefore wrong in
 * exactly the cases that matter most: a change carrying decisions is the one a
 * reviewer splits, and the confirmation promised N while the success toast then
 * reported N+1. Two numbers for one action is how an operator learns to stop
 * reading confirmations.
 *
 * The catch-all is named rather than counted silently, because "3 pending
 * changes" from a 2-page change reads as a bug until the reviewer sees the third
 * one in the queue and can recognise it by its title.
 *
 * Full split only. Defer (`split` with a concept list) never produces the
 * catch-all: the parent stays PENDING and keeps its decisions and its remaining
 * markers, so nothing is orphaned and there is nothing to rescue.
 *
 * Two things this leans on, both worth stating because a future reader will
 * otherwise re-derive them: 0027 re-declares `wk_split_proposal` verbatim apart
 * from the review-channel whitelist, so 0020 is still the reasoning to read; and
 * the function counts `status = 'proposed'` decisions while the wire sends every
 * staged decision regardless of status — the same set, because decisions only
 * flip to `active` in `wk_approve_proposal` and the split button exists only
 * while the change is pending.
 */
export function splitPlan(scope: SplitScope): SplitPlan {
  const staged = new Set(scope.concepts.map((concept) => concept.slug))
  const orphanedRemovals = scope.relations_removed.filter((edge) => !staged.has(edge.from_slug)).length
  const decisions = scope.decisions.length
  if (decisions === 0 && orphanedRemovals === 0) return { children: scope.concepts.length, leftovers: null }

  const holds = [
    decisions > 0 ? count(decisions, 'decision') : null,
    orphanedRemovals > 0
      ? `${count(orphanedRemovals, 'relation removal')} from a page this change does not stage`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' and ')
  return { children: scope.concepts.length + 1, leftovers: { title: `${scope.title} — decisions`, holds } }
}

/* ----------------------------------------------------------------- claims */

/** A claim, as the wire carries one: subject–predicate–object and nothing else. */
export interface ClaimTriple {
  subject: string
  predicate: string
  object: string
}

/** What this change does to a claim. `null` is a staged claim it leaves alone. */
export type ClaimChange = 'added' | 'disputed' | 'deprecated' | null

export interface ClaimReview<C> {
  /** The claims this change stages, each labelled with what happens to it. */
  staged: { claim: C; change: ClaimChange }[]
}

/**
 * Match the three triple lists against the staged claims.
 *
 * The detail response reports a concept's claims twice over, and the two halves
 * answer different questions. `claims` carries the full staged rows — status,
 * confidence, collision flag, and the verbatim citation quotes that are the
 * entire reason WikiKit exists. `claims_added` / `claims_disputed` /
 * `claims_deprecated` carry bare triples and say what the change DOES.
 *
 * A reviewer needs both facts on one line: this sentence is being added, and
 * here is the quote that backs it. So the lists are joined on the triple, and
 * the result is one row per STAGED claim — never a second list.
 *
 * A triple that is disputed or deprecated WITHOUT being staged would be exactly
 * that second list, and it cannot arrive: `buildProposalDetail` in
 * `src/domain/proposals.ts` derives all four fields from the same per-concept
 * array, so every triple in the three lists is by construction also a staged
 * row. This file used to carry a branch and a render block for the other case;
 * they were unreachable, and a block that claims to handle a case it can never
 * receive is worse than no block, because the next reader believes the surface
 * is covered. For it to come back the server would have to report the claims a
 * change knocks down on OTHER pages — triples it acts on but never stages — and
 * that is a change to the wire contract first, not to this function.
 */
export function annotateClaims<C extends ClaimTriple>(concept: {
  claims: readonly C[]
  claims_added: readonly ClaimTriple[]
  claims_disputed: readonly ClaimTriple[]
  claims_deprecated: readonly ClaimTriple[]
}): ClaimReview<C> {
  const added = new Set(concept.claims_added.map(tripleKey))
  const disputed = new Set(concept.claims_disputed.map(tripleKey))
  const deprecated = new Set(concept.claims_deprecated.map(tripleKey))

  const staged = concept.claims.map((claim) => {
    const key = tripleKey(claim)
    // Order matters: a claim can appear in more than one list, and the strongest
    // consequence is the one a reviewer has to see. Being retired outranks being
    // disputed, which outranks being new.
    const change: ClaimChange = deprecated.has(key)
      ? 'deprecated'
      : disputed.has(key)
        ? 'disputed'
        : added.has(key)
          ? 'added'
          : null
    return { claim, change }
  })
  return { staged }
}

/** A NUL join, so a subject ending in a separator cannot collide with the next field. */
function tripleKey(triple: ClaimTriple): string {
  return `${triple.subject}\u0000${triple.predicate}\u0000${triple.object}`
}

/* -------------------------------------------------------------- provenance */

/**
 * Who or what wrote this change, from `agent_meta`.
 *
 * The server stamps `{ model: 'manual', prompt_version: 'manual' }` on anything
 * posted without provenance, precisely so the audit is never blank — so
 * "manual" is a real answer here and not a missing one. Everything else names
 * the model and the prompt version that produced the text, which is the first
 * thing a reviewer wants when a page reads oddly: the same model getting the
 * same thing wrong twice is a different problem from one bad run.
 */
export function proposedBy(agentMeta: Record<string, unknown> | null | undefined): string {
  const model = typeof agentMeta?.model === 'string' ? agentMeta.model : null
  const promptVersion = typeof agentMeta?.prompt_version === 'string' ? agentMeta.prompt_version : null
  if (!model) return 'Unrecorded'
  if (model === 'manual') return 'A person, writing directly'
  return promptVersion && promptVersion !== 'manual' ? `${model} (prompt ${promptVersion})` : model
}

/* ------------------------------------------------------------------- lint */

/**
 * Lint findings, split by what they are about.
 *
 * The grouping is the rule: a finding that names a `concept_slug` belongs beside
 * that page's diff, where the reviewer is already looking, and one that does not
 * belongs to the change as a whole. A flat list at the bottom of the page makes
 * the reviewer carry a slug in their head back up to the diff — which is exactly
 * the moment a missing citation gets approved.
 *
 * Pages keep their first-appearance order so the list matches the order the
 * server sent the findings in, and the concept order the page renders.
 */
export interface LintGroups<F> {
  general: F[]
  byConcept: { slug: string; findings: F[] }[]
}

export function groupFindings<F extends { concept_slug?: string }>(findings: readonly F[]): LintGroups<F> {
  const groups: LintGroups<F> = { general: [], byConcept: [] }
  for (const finding of findings) {
    const slug = finding.concept_slug
    if (!slug) {
      groups.general.push(finding)
      continue
    }
    const existing = groups.byConcept.find((group) => group.slug === slug)
    if (existing) existing.findings.push(finding)
    else groups.byConcept.push({ slug, findings: [finding] })
  }
  return groups
}

export function findingsFor<F>(groups: LintGroups<F>, slug: string): F[] {
  return groups.byConcept.find((group) => group.slug === slug)?.findings ?? []
}

/**
 * A lint severity as one of the five domain states.
 *
 * The proposal lint enum is `error | warn | info` while `SEVERITY_STATE` is keyed
 * on `error | warning | info`, and that one missing letter is the whole reason
 * this function exists rather than an index at the call site: `SEVERITY_STATE['warn']`
 * is `undefined`, and a `?? 'unknown'` beside it would render every warning as
 * "nothing has been measured" — the one reading a warning must never get.
 */
export function severityState(severity: string): DomainState {
  return SEVERITY_STATE[severity === 'warn' ? 'warning' : severity] ?? 'unknown'
}

/**
 * A domain state as the tone a `Badge` takes.
 *
 * `STATE_TOKEN` already maps the five states onto the palette, but onto CSS
 * custom-property names — `muted-foreground`, `destructive` — which are what an
 * SVG stroke needs and not what `Badge` accepts. Rather than let the queue and
 * the change page each guess, the translation lives here once: `unknown` becomes
 * the dashed `unknown` tone and never `neutral`, because "nothing has been
 * decided" has to stay visibly distinct from "this is fine".
 */
export function badgeTone(state: DomainState): 'success' | 'danger' | 'accent' | 'warning' | 'unknown' {
  if (state === 'succeeded') return 'success'
  if (state === 'failed') return 'danger'
  if (state === 'running') return 'accent'
  if (state === 'blocked') return 'warning'
  return 'unknown'
}

/** `error | warn | info` in the reviewer's words. */
export function severityLabel(severity: string): string {
  if (severity === 'error') return 'Error'
  if (severity === 'warn') return 'Warning'
  if (severity === 'info') return 'Note'
  return severity
}

/* ------------------------------------------------------------------ misc */

/**
 * The public review address for a change.
 *
 * A machine address, not a door: it is what an agent hands a human when its
 * client cannot render an approval form, and a reviewer sometimes has to pass it
 * on. It is rendered as text to be copied, never as a button — this console is
 * already authenticated, so following it would take the operator to a page that
 * asks them for an API key they do not have in front of them.
 */
export function reviewUrl(id: string): string {
  return `/review/${id}`
}

/** `1 page` / `2 pages`, so a sentence never reads "1 pages". */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}
