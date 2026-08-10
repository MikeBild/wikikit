import { useEffect, useId, useReducer, useRef, type ReactNode } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import { useI18n } from '@/lib/i18n-context'
import {
  ANNOUNCED_ANCHOR,
  CLOSED,
  NOMINATED_ANCHOR,
  canConfirm,
  isBusy,
  isOpen,
  planRestore,
  reduce,
  type AncestorView,
} from '@/components/confirm.logic'

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ EVERY DESTRUCTIVE OR CONSEQUENTIAL MUTATION GOES THROUGH THIS.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The console hand-rolled this dialog five times — the proposal decision, the
 * API key revocation, the ingest cancel, the charter rewrite, the space
 * archive. The behaviour was good and it was consistent, which is exactly why the
 * duplication was easy to live with and worth ending: five copies share no
 * focus-restoration story, and `contract/conformance.cockpit-ui.json` said so
 * out loud, grading `CUI-A11Y-1`, `-2` and `-3` as unenforced with "no test
 * drives a dialog" written next to them.
 *
 * Four properties, and each one is a thing the five copies did not have:
 *
 *  - **Escape cancels; a click outside does nothing at all.** `AlertDialog` has
 *    no light-dismiss and that is the reason it is the primitive here rather
 *    than `Dialog`, which closes on a pointer-down outside. A confirmation a
 *    stray click can answer is not a confirmation, and approving a change
 *    proposal into a space is precisely the decision a reviewer must not be
 *    able to give by clicking past it.
 *  - **Focus is trapped, and on close it lands somewhere the operator can carry
 *    on working — never on `<body>`.** The trap is Radix's `FocusScope`. Where
 *    focus goes afterwards is this file's, because Radix cannot do it here: its
 *    modal content cancels its own restore (`event.preventDefault()`) and
 *    focuses `context.triggerRef.current` instead, a ref only
 *    `AlertDialogTrigger` ever sets — and the trigger here is deliberately the
 *    caller's own control, carrying the caller's `data-testid`, `disabled` and
 *    scope check. The ref is `null`, the `?.` swallows the call, the built-in
 *    restore has already been cancelled, and focus lands on `<body>`: a keyboard
 *    operator who answers a dialog is dropped at the top of the document. Radix
 *    composes the caller's handler first and skips its own once the event is
 *    default-prevented, so preventing it below takes that line out of the path.
 *
 *    Three shapes have to be answered, because this console produces all three:
 *      1. the trigger is still mounted and can take focus — it gets it back;
 *      2. the trigger is still mounted but disabled (`disabled={isPending}`
 *         outliving the close by a refetch or a toast) — focus goes to the
 *         structure the trigger lived in, and back to the trigger the moment it
 *         can take it, unless the operator has moved or typed first;
 *      3. the trigger is gone, deleted with the row it sat in — the ordinary
 *         destructive path, not an edge case: focus goes to that same structure
 *         and stays there, because there is nothing else honest to point at and
 *         the next Tab is the row that took the deleted one's place.
 *    Which of the three applies, and which ancestor "that structure" is, is
 *    decided in `confirm.logic.ts` and unit-tested there. This file supplies the
 *    facts and performs the move.
 *  - **A refusal is announced.** A server that declines is the one thing here an
 *    operator must not miss, and in the five copies it was a coloured banner
 *    nobody was told about. `Alert` carries `role="alert"`, so it reaches a
 *    screen reader the moment it appears, and it is named in the dialog's own
 *    `aria-describedby` so a reader arriving after the announcement still gets
 *    the reason and whatever counts came with it.
 *  - **Nothing is dismissed mid-flight.** While the mutation is in the air the
 *    dialog refuses to close: the answer is what closes it. A request whose
 *    outcome is unknown must not leave the screen claiming to have been
 *    cancelled.
 *
 * And one property none of the five copies had, because it is this console's
 * own idiom carried one layer further. `DataState` renders a `403` with no retry
 * button — WikiKit knows exactly who you are and the answer is no, so offering
 * "Try again" teaches the operator to press a button that cannot ever work. A
 * mutation refused with `403` is the same fact, so a terminal refusal here
 * withdraws the Confirm button and leaves the way out, with the server's
 * `next_best_actions` rendered underneath: the console stops asking and starts
 * saying what to do instead.
 *
 * The dialog names the exact target and the exact effect before a decision is
 * recorded, and dismissing it changes nothing. That part is not new — it is the
 * part the five copies got right, and it is why this is a consolidation rather
 * than a redesign.
 */

/**
 * The names a call site addresses the parts of this dialog by.
 *
 * Every interactive element carries a `data-testid` (`CUI-A11Y-4`), and the
 * defaults below are what a new call site gets for free. The override exists
 * because the five surfaces being consolidated already have ids that page tests
 * and operators name — `decide-dialog`, `decide-confirm`, `cancel-dialog` —
 * and renaming a production procedure to suit a refactor is a cost paid by
 * somebody who was not in the room.
 *
 * Only the parts that are *acted on* are overridable. `confirm-title`,
 * `confirm-description`, `confirm-details` and `confirm-error-message` stay
 * fixed: they are read, not clicked, and one stable name for them across every
 * confirmation in the console is worth more than a local one.
 */
export type ConfirmIds = Partial<Record<'dialog' | 'cancel' | 'accept' | 'error', string>>

const DEFAULT_IDS: Record<keyof ConfirmIds, string> = {
  dialog: 'confirm-dialog',
  cancel: 'confirm-cancel',
  accept: 'confirm-accept',
  error: 'confirm-error',
}

/**
 * Focus `element` and report whether it actually took it.
 *
 * A detached node, a `disabled` control and an `inert` subtree all refuse
 * silently — `focus()` returns nothing either way — so the document is the only
 * witness. Every decision below turns on this answer rather than on inspecting
 * attributes, because the list of reasons an element declines focus is longer
 * than any check would be.
 */
function focusOn(element: HTMLElement): boolean {
  if (!element.isConnected) return false
  element.focus()
  return document.activeElement === element
}

export function Confirm({
  title,
  description,
  details,
  confirmLabel = 'Confirm',
  destructive,
  onConfirm,
  ids,
  children,
}: {
  title: string
  /** What is about to happen, in the words of someone using the product. */
  description: ReactNode
  /**
   * The exact effect, restated. The review queue puts the effect description
   * the server sent with the change proposal here; a delete puts what goes with
   * the row — the claims that cite the source about to be removed. Optional
   * because some confirmations are one sentence and padding them out with a box
   * is how an operator learns to stop reading the box.
   */
  details?: ReactNode
  confirmLabel?: string
  destructive?: boolean
  /** Throwing is how a refusal gets here; the thrown `ApiError` supplies its own words. */
  onConfirm: () => Promise<unknown> | unknown
  /** See `ConfirmIds`. Omitted except where a surface already has names in use. */
  ids?: ConfirmIds
  children: (open: () => void) => ReactNode
}) {
  const { t } = useI18n()
  const [state, dispatch] = useReducer(reduce, CLOSED)
  const id = (part: keyof typeof DEFAULT_IDS) => ids?.[part] ?? DEFAULT_IDS[part]

  const effectId = useId()
  const refusalId = useId()

  const busy = isBusy(state)
  const refusal = state.refusal

  /**
   * The control focus has to go back to: whatever had it when the dialog
   * opened, which at every call site is the trigger the operator just pressed.
   */
  const restoreTo = useRef<HTMLElement | null>(null)
  /** The trigger's ancestors, nearest first, read at open time. See `RestoreInput.lineage`. */
  const lineage = useRef<HTMLElement[]>([])
  const retry = useRef<number | null>(null)
  /** Tears down the hand-back watcher; null when nothing is watching. */
  const stopWatching = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      if (retry.current !== null) window.clearTimeout(retry.current)
      stopWatching.current?.()
    },
    [],
  )

  const view = (element: HTMLElement): AncestorView => ({
    connected: element.isConnected,
    matchesNominated: element.matches(NOMINATED_ANCHOR),
    matchesAnnounced: element.matches(ANNOUNCED_ANCHOR),
  })

  /**
   * Put focus on the structure the trigger lived in.
   *
   * The `tabindex="-1"` is added only to make the element focusable
   * programmatically and removed again on blur — an anchor left carrying one
   * would put a `<table>` into the Tab order of every page that renders it,
   * which is a different bug traded for this one.
   */
  function park(anchor: HTMLElement): HTMLElement | null {
    if (anchor.hasAttribute('tabindex')) return focusOn(anchor) ? anchor : null
    anchor.setAttribute('tabindex', '-1')
    if (!focusOn(anchor)) {
      anchor.removeAttribute('tabindex')
      return null
    }
    anchor.addEventListener('blur', () => anchor.removeAttribute('tabindex'), { once: true })
    return anchor
  }

  /**
   * Wait for a still-mounted trigger to become able to take focus, and hand it
   * back when it does.
   *
   * The window is behavioural, not a timer: it ends the moment the operator does
   * anything at all — a key, a pointer, a focus move away from where focus was
   * parked — because a jump back to a control they have stopped looking at is a
   * steal, however well meant. It also ends when the trigger is removed, and on
   * unmount. So the hand-back can only happen while the operator is still
   * exactly where the close left them, which is the only moment it is an
   * improvement.
   */
  function watchForHandBack(target: HTMLElement, anchor: HTMLElement) {
    const observer = new MutationObserver(() => {
      if (!target.isConnected || document.activeElement !== anchor) return stop()
      if (focusOn(target)) stop()
    })
    const onFocusIn = (event: FocusEvent) => {
      if (event.target !== anchor) stop()
    }
    const onOperatorInput = () => stop()
    function stop() {
      stopWatching.current = null
      observer.disconnect()
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('keydown', onOperatorInput, true)
      document.removeEventListener('pointerdown', onOperatorInput, true)
    }

    observer.observe(target, {
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'hidden', 'inert', 'tabindex'],
    })
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('keydown', onOperatorInput, true)
    document.addEventListener('pointerdown', onOperatorInput, true)
    stopWatching.current = stop
  }

  function restoreFocus() {
    const target = restoreTo.current
    const chain = lineage.current
    restoreTo.current = null
    lineage.current = []
    if (retry.current !== null) window.clearTimeout(retry.current)
    stopWatching.current?.()

    const immediate = planRestore({
      hasTrigger: target !== null,
      // Shape 1 is decided by trying it: the document is the only witness that
      // an element took focus, so the attempt IS the question.
      triggerTookFocus: target !== null && focusOn(target),
      triggerConnected: target?.isConnected ?? false,
      lineage: chain.map(view),
    })
    if (immediate.target !== 'anchor') return

    // Shape 3: the trigger went out with the row it sat in. A detached node
    // never comes back, so there is nothing to wait for and the structure it was
    // deleted from is the answer, immediately.
    if (!immediate.handBack) {
      const anchor = chain[immediate.index]
      if (anchor) park(anchor)
      return
    }

    // Shape 2: mounted but refusing focus, which in this console means
    // `disabled={mutation.isPending}` with `isPending` not yet cleared. Usually
    // it clears in the same breath as the close, so one macrotask is all it
    // takes and the operator never sees the intermediate step. Only when it does
    // not — a chained invalidation, a queued toast, a slow refetch — does focus
    // go to the structure instead, and then it is handed back if and when the
    // trigger can take it.
    retry.current = window.setTimeout(() => {
      retry.current = null
      // Anything else having taken focus meanwhile is a deliberate move — a
      // reopened dialog, a toast action — and is never stolen from.
      const stranded = document.activeElement === null || document.activeElement === document.body
      if (!stranded) return

      const late = planRestore({
        hasTrigger: true,
        triggerTookFocus: focusOn(target as HTMLElement),
        triggerConnected: (target as HTMLElement).isConnected,
        lineage: chain.map(view),
      })
      if (late.target !== 'anchor') return
      const element = chain[late.index]
      if (!element) return
      const anchor = park(element)
      if (anchor && late.handBack) watchForHandBack(target as HTMLElement, anchor)
    }, 0)
  }

  async function run() {
    dispatch({ type: 'confirm' })
    try {
      await onConfirm()
      dispatch({ type: 'settled' })
    } catch (failure) {
      dispatch({ type: 'failed', error: failure })
    }
  }

  /**
   * What the caller's trigger calls. It runs on a click, never during render —
   * the render prop below receives it, it does not invoke it — and the two refs
   * it fills are the whole reason it exists rather than being an effect.
   *
   * `react-hooks/refs` cannot see that: from where the rule stands, a function
   * that writes a ref and is passed out during render is a ref written during
   * render. The disable is on the render-prop line below, and the argument for
   * it is the one `ui/dialog.tsx` already makes — by effect time Radix's
   * `FocusScope` has moved focus into the panel, so the trigger is only knowable
   * at the moment it is pressed. So is its lineage: see `RestoreInput.lineage`
   * for why reading the ancestors now rather than on close is the difference
   * between finding the table and walking into a detached fragment.
   */
  function openFromCurrentFocus() {
    const active = document.activeElement
    const trigger = active instanceof HTMLElement && active !== document.body ? active : null
    restoreTo.current = trigger
    // `<body>` ends the walk — it is an ancestor of everything and a position in
    // nothing.
    const chain: HTMLElement[] = []
    for (let node = trigger?.parentElement ?? null; node && node !== document.body; node = node.parentElement) {
      chain.push(node)
    }
    lineage.current = chain
    dispatch({ type: 'open' })
  }

  return (
    <>
      {/* Handed out, not called — see `openFromCurrentFocus`. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {children(openFromCurrentFocus)}
      <AlertDialog
        open={isOpen(state)}
        onOpenChange={(next) => {
          // Opening only ever happens through the trigger above, and every named
          // way out is wired explicitly below. This is the catch-all for a close
          // Radix asks for by some path this file did not name, and it is
          // treated as the operator pressing Escape — which the machine refuses
          // while a request is in the air.
          if (next) return
          dispatch({ type: 'dismiss', via: 'escape' })
        }}
      >
        <AlertDialogContent
          data-testid={id('dialog')}
          // Radix points this at the description alone; a refusal has to be part
          // of what describes the dialog too, or the reason is announced once and
          // is then unreachable to a reader that re-reads the box.
          aria-describedby={refusal ? `${effectId} ${refusalId}` : effectId}
          onEscapeKeyDown={(event) => {
            // This file owns every close, so Radix is stopped either way: the
            // machine decides, and while the mutation is in the air it decides
            // no.
            event.preventDefault()
            dispatch({ type: 'dismiss', via: 'escape' })
          }}
          // There is deliberately no `onInteractOutside` here, and it is not an
          // omission: `AlertDialogContentProps` does not have the prop. Radix
          // forces the refusal inside the primitive and does not offer a way to
          // turn it back on, so "a stray click cannot answer this" is held by
          // the type of the component rather than by a line somebody could
          // delete. `confirm.logic.ts` still answers the `outside` route, so the
          // day this is swapped for a primitive that does light-dismiss, the
          // machine already says no.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="confirm-title">{title}</AlertDialogTitle>
            <AlertDialogDescription id={effectId} data-testid="confirm-description">
              {description}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* The middle grid row, and it exists only when it holds something:
              an empty one still takes the panel's gap, so a one-sentence
              confirmation would carry a band of nothing between its question and
              its two buttons. `min-h-0` plus `overflow-y-auto` is what makes the
              row the one that gives when a long effect description or a refusal
              with three next-best-actions is taller than the viewport — the
              header and the footer keep their size, which is the whole reason
              the footer cannot be pushed off the bottom at 390px. */}
          {details || refusal ? (
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
              {details ? (
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="confirm-details">
                  {details}
                </div>
              ) : null}

              {/* The server's own words, in the one place the operator is
                  looking. `Alert` carries `role="alert"`, so this is heard as
                  well as seen, and it does not replace the description: what was
                  going to happen is still on screen next to why it did not. A
                  403 wears `warning` and no retry, exactly as `DataState`
                  renders one. */}
              {refusal ? (
                <Alert
                  id={refusalId}
                  tone={refusal.terminal ? 'warning' : 'danger'}
                  title={refusal.title}
                  actions={refusal.actions}
                  data-testid={id('error')}
                >
                  <span data-testid="confirm-error-message">{refusal.message}</span>
                </Alert>
              ) : null}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid={id('cancel')}
              disabled={busy}
              onClick={(event) => {
                // This file owns the close; Radix's own is prevented so there is
                // exactly one path and the machine is on it.
                event.preventDefault()
                dispatch({ type: 'dismiss', via: 'cancel' })
              }}
            >
              {/* A refusal that cannot be retried leaves nothing to cancel — the
                  operator is reading, and the control they are standing on
                  should say what it now does. */}
              {t(refusal?.terminal ? 'common.close' : 'common.cancel')}
            </AlertDialogCancel>
            {canConfirm(state) || busy ? (
              <AlertDialogAction
                data-testid={id('accept')}
                variant={destructive ? 'destructive' : 'default'}
                disabled={busy}
                aria-busy={busy}
                // Focus does not move on a refusal, so this is the control the
                // operator is standing on when it lands: describing it with the
                // refusal means tabbing back to it says why it failed.
                aria-describedby={refusal ? refusalId : undefined}
                // Radix closes on this click; the mutation has not answered yet,
                // so the close is refused here and the answer is what closes it.
                // A dialog that vanished on click would report a success it has
                // not had.
                onClick={(event) => {
                  event.preventDefault()
                  void run()
                }}
              >
                {/* A button never rewrites its label while it works: spinner plus
                    `disabled`, and the label stays the promise it made. */}
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {confirmLabel === 'Confirm' ? t('common.confirm') : confirmLabel}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
