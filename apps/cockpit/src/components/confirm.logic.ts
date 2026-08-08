/**
 * Everything the confirmation dialog DECIDES, with nothing it draws.
 *
 * The console already splits a page into `<name>.tsx` and `<name>.logic.ts` so
 * the judgement can be tested and the markup can be read. This is that split
 * applied to the one component every destructive mutation goes through, and it
 * earns the split harder than any page does: the interesting claims about a
 * confirmation are not about pixels. "It cannot be dismissed while the request
 * is in the air" and "focus lands somewhere a reader announces" are decisions,
 * and a decision is a function.
 *
 * Two constraints shape this file and both are load-bearing:
 *
 *  - **No DOM types.** The unit runner compiles `test/` with `lib: ES2023` and
 *    no `DOM` — deliberately, because the server is the product and the console
 *    is a guest in this repository. So the focus decision is expressed over a
 *    view of the tree (`connected`, `nominated`, `announced`) that `confirm.tsx`
 *    reads off real elements and hands in. The consequence is worth stating
 *    plainly: what a test in this repository can hold is which element focus is
 *    *aimed at*, never that a browser moved it.
 *  - **No import of the API client.** A refusal is classified by reading two
 *    fields off whatever was thrown. `ApiError` carries `status` and
 *    `nextBestActions`, and the facade throws nothing else — but importing it
 *    here would drag `openapi-fetch` and the whole generated client behind it
 *    into a file whose entire job is to read two fields off a thrown value, so
 *    the shape is read structurally instead.
 */

/**
 * `closed` — nothing asked.
 * `asking` — the effect is restated and the operator has not answered.
 * `running` — the mutation is in the air and its answer is the only thing that
 *   may close this.
 * `refused` — the server said no. The dialog stays up, because the reason is
 *   the whole point and a box that vanishes takes the reason with it.
 */
export type ConfirmPhase = 'closed' | 'asking' | 'running' | 'refused'

export interface Refusal {
  /** The banner heading. Never the server's job — the server owns `message`. */
  title: string
  /** The server's own words, verbatim (`CUI-LOAD-2`). */
  message: string
  /** `next_best_actions`, rendered rather than dropped. */
  actions: readonly string[]
  /**
   * A `403`: WikiKit knows exactly who you are and the answer is no.
   *
   * `DataState` already refuses to offer "Try again" on a 403, because a button
   * that cannot ever work teaches the operator to press buttons that cannot
   * ever work. The same reasoning applies to a mutation and nothing about it
   * changes: pressing Confirm a second time against a scope you do not hold —
   * `knowledge:approve` on a proposal you may only read — spends another round
   * trip to be told the same thing. So a terminal refusal withdraws the confirm
   * affordance and leaves the way out.
   */
  terminal: boolean
}

export interface ConfirmState {
  phase: ConfirmPhase
  refusal: Refusal | null
}

export const CLOSED: ConfirmState = { phase: 'closed', refusal: null }

/**
 * How a close was asked for. `escape` and `cancel` are answers; `outside` is
 * not, and the distinction is the reason the route is carried at all.
 *
 * An alert dialog has no light-dismiss. That is not a stylistic preference: a
 * confirmation a stray click can answer is not a confirmation, and approving a
 * change proposal into a space is the exact thing a reviewer must not be able
 * to dismiss by clicking past it.
 *
 * Nothing dispatches `outside` today, and that is the strongest form the
 * property takes rather than a gap: Radix's `AlertDialogContentProps` does not
 * carry `onInteractOutside` at all, so the refusal is held by the type of the
 * component and there is no line to delete. The row stays in this table anyway,
 * because the machine is where the console's own answer lives — swap the
 * primitive for one that does light-dismiss and the answer is already no,
 * instead of being a default that quietly changed.
 */
export type DismissRoute = 'escape' | 'cancel' | 'outside'

export type ConfirmEvent =
  | { type: 'open' }
  | { type: 'confirm' }
  | { type: 'settled' }
  | { type: 'failed'; error: unknown }
  | { type: 'dismiss'; via: DismissRoute }

/** True when a `403`-shaped refusal is what came back. */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

function actionsOf(error: unknown): readonly string[] {
  if (typeof error !== 'object' || error === null) return []
  const actions = (error as { nextBestActions?: unknown }).nextBestActions
  if (!Array.isArray(actions)) return []
  return actions.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Turn whatever was thrown into the sentence the operator reads.
 *
 * The message is the server's, untouched. A `409` that says which two claims
 * still cite the source being deleted, or a `422` that names the field, is
 * exactly the text that makes the refusal actionable, and a summary of it
 * throws away the only part with information in it.
 *
 * The fallback exists for the one case the facade cannot produce a message
 * for — a network failure with an empty `Error` — and it is deliberately not a
 * diagnosis: the console does not know why, and saying so is better than
 * guessing.
 */
export function describeFailure(error: unknown): Refusal {
  const terminal = statusOf(error) === 403
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return {
    title: terminal ? 'Not permitted' : 'The server refused',
    message: raw.trim() === '' ? 'The request failed and the server gave no reason.' : raw,
    actions: actionsOf(error),
    terminal,
  }
}

/**
 * The whole life of a confirmation, in one total function.
 *
 * Total is the point. Every event is answered from every phase, so "can this be
 * dismissed mid-flight?" is not a question about which handlers happen to be
 * wired — it is a row in a table, and the row says no.
 */
export function reduce(state: ConfirmState, event: ConfirmEvent): ConfirmState {
  switch (event.type) {
    case 'open':
      // Reopening while a request is in the air would put a second dialog over
      // an unanswered one; the trigger is disabled by then at every call site,
      // and this is what makes that a guarantee rather than a convention.
      if (state.phase === 'running') return state
      // A refusal from the last time this was opened is not news about this
      // time. It goes when the box does.
      return { phase: 'asking', refusal: null }

    case 'confirm':
      if (state.phase === 'running' || state.phase === 'closed') return state
      // A terminal refusal has no retry. See `Refusal.terminal`.
      if (state.refusal?.terminal) return state
      return { phase: 'running', refusal: null }

    case 'settled':
      // Only a request that was actually in the air can close this by settling.
      return state.phase === 'running' ? CLOSED : state

    case 'failed':
      return state.phase === 'running' ? { phase: 'refused', refusal: describeFailure(event.error) } : state

    case 'dismiss':
      // An interaction outside the box is not an answer, in any phase.
      if (event.via === 'outside') return state
      // A request whose outcome is unknown must not leave the screen claiming
      // to have been cancelled. Its answer is what closes it.
      if (state.phase === 'running') return state
      return CLOSED
  }
}

/** The box is on screen. */
export const isOpen = (state: ConfirmState): boolean => state.phase !== 'closed'

/** The mutation is in the air: nothing here may be dismissed or pressed. */
export const isBusy = (state: ConfirmState): boolean => state.phase === 'running'

/** Whether the confirm affordance is offered at all — see `Refusal.terminal`. */
export const canConfirm = (state: ConfirmState): boolean =>
  (state.phase === 'asking' || state.phase === 'refused') && state.refusal?.terminal !== true

/**
 * An ancestor the call site nominates itself, for a trigger whose meaningful
 * neighbour is not the nearest announced one. Nothing in this console needs it
 * today; it exists so a call site with an unusual shape has an answer that is
 * not "widen the roster below and hope".
 */
export const NOMINATED_ANCHOR = '[data-focus-anchor]'

/**
 * What counts as somewhere to put focus when the trigger cannot take it.
 *
 * Every entry is an element a screen reader announces as *something* — "table",
 * "list", "form", "region", "main" — so an operator who has just lost the
 * control they were standing on is told where they now are, instead of being
 * dropped on an anonymous `<div>` that reads as nothing. `[tabindex]` is here
 * because an author who put one on an ancestor has already declared it a focus
 * target.
 *
 * A `<table>` with no accessible name still qualifies: a reader says "table, 4
 * columns, 12 rows", which is a position. `<div className="rounded-lg border">`
 * does not qualify, and that exclusion is the whole value of the roster — it is
 * the nearest surviving ancestor of almost every trigger in this console, and
 * admitting it would make the promise mean "an ancestor", which is to say
 * nothing.
 */
export const ANNOUNCED_ANCHOR = [
  '[tabindex]',
  'table',
  'form',
  'dialog',
  'nav',
  'main',
  'section[aria-label]',
  'section[aria-labelledby]',
  // Unquoted, because a quoted value here reads as this component *setting* a
  // role, which is the one thing it must never do — these are roles it looks
  // for on somebody else's element. CSS treats an identifier and a quoted
  // string identically inside an attribute selector.
  ...[
    'table',
    'grid',
    'treegrid',
    'list',
    'listbox',
    'feed',
    'form',
    'dialog',
    'alertdialog',
    'region',
    'navigation',
    'main',
  ].map((role) => `[role=${role}]`),
].join(',')

/**
 * One ancestor of the trigger, as `confirm.tsx` sees it at restore time.
 *
 * `connected` is read at restore time and the rest at open time, because that
 * is when they are still knowable — see `RestoreInput.lineage`.
 */
export interface AncestorView {
  /** Still in the document. A detached ancestor is not a place. */
  connected: boolean
  matchesNominated: boolean
  matchesAnnounced: boolean
}

export interface RestoreInput {
  /** False when nothing had focus at open time — a dialog opened from a script. */
  hasTrigger: boolean
  /** The trigger accepted `focus()`: the document agrees it is the active element. */
  triggerTookFocus: boolean
  /** The trigger is still in the document, whether or not it can take focus. */
  triggerConnected: boolean
  /**
   * The trigger's ancestors, nearest first, **captured while the dialog opened**
   * rather than when it closed. The timing is the reason this is an input at all.
   *
   * Deleting a row removes the `<tr>` the trigger sat in. From that moment
   * `trigger.parentElement` still walks — up through the `<td>` and the `<tr>` —
   * but into a detached fragment that is nowhere on screen, and it stops dead
   * where React unhooked the row. The `<table>` the operator is still looking at
   * is no longer reachable from the trigger at all. Read at open time the chain
   * runs all the way up, and afterwards the survivors are the ones still
   * `connected`.
   */
  lineage: readonly AncestorView[]
}

export type RestorePlan =
  /** Shape 1: the trigger is there and took it. Every non-destructive confirmation ends here. */
  | { target: 'trigger' }
  /**
   * Shapes 2 and 3: the structure the trigger lived in, by index into `lineage`.
   *
   * `handBack` separates them. Shape 2 is a trigger that is still mounted and
   * momentarily refusing focus — `disabled={mutation.isPending}` outliving the
   * close by a refetch or a toast — and it is still the better answer the moment
   * it can take focus, so the anchor is a waiting room. Shape 3 is a trigger
   * that went out with its row: a detached node never comes back, there is
   * nothing to wait for, and the list it was deleted from is the answer for good.
   */
  | { target: 'anchor'; index: number; handBack: boolean }
  /**
   * Nowhere honest to point. `no-trigger` means nothing had focus to begin with;
   * `no-anchor` means the trigger had no announced ancestor left on screen —
   * which is a call site to fix, not a promise to bend, so the browser is left
   * where it is rather than focus being dropped on the first `<div>` that
   * accepts it.
   */
  | { target: 'nowhere'; why: 'no-trigger' | 'no-anchor' }

/**
 * The nearest surviving ancestor worth landing on.
 *
 * Nearest first, so a row's delete button lands on its own table rather than on
 * the page landmark twelve levels up: the closer the anchor, the shorter the
 * distance the operator has to re-cross. A nomination wins over proximity —
 * a call site that named its anchor knows something this roster does not.
 */
export function chooseAnchor(lineage: readonly AncestorView[]): number {
  const nominated = lineage.findIndex((node) => node.connected && node.matchesNominated)
  if (nominated !== -1) return nominated
  return lineage.findIndex((node) => node.connected && node.matchesAnnounced)
}

/** Where focus goes when the dialog closes. */
export function planRestore(input: RestoreInput): RestorePlan {
  if (!input.hasTrigger) return { target: 'nowhere', why: 'no-trigger' }
  if (input.triggerTookFocus) return { target: 'trigger' }

  const index = chooseAnchor(input.lineage)
  if (index === -1) return { target: 'nowhere', why: 'no-anchor' }
  return { target: 'anchor', index, handBack: input.triggerConnected }
}
