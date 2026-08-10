import { AlertTriangle, CircleCheck, Info, OctagonAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/lib/theme'
import { dismissToast, useToasts, type ToastRecord, type ToastTone } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n-context'

/**
 * The corner where the console says what just happened.
 *
 * It exists because fourteen mutation sites reported nothing at all on success,
 * and because an error raised by a mutation whose dialog closes on settle had
 * nowhere left to be shown: the dialog that would have held the message is gone
 * by the time the message arrives. The operator saw a dialog vanish and had to
 * infer from the list whether the world changed.
 *
 * Two things this layer is NOT allowed to become:
 *
 *   1. A place a refusal expires from. `warning` and `danger` stay until they
 *      are dismissed — see `TOAST_DURATION_MS` in `lib/toast-store.ts`, which is
 *      where that schedule lives and where a test can advance it.
 *   2. A substitute for the page saying what state it is in. A toast is the
 *      transition; the surface behind it still has to show the result. Anything
 *      an operator might need in ten minutes belongs in an `Alert` or in the
 *      row itself, not here.
 *
 * The queue, the durations and the eviction rule are all in the pure store. This
 * file is the rendering, and nothing else.
 */

const ICONS: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: AlertTriangle,
  danger: OctagonAlert,
}

/**
 * Severity colours, never chart colours (CUI-SEV-1) — the same table `Alert`
 * uses, so a refusal reads the same whether it lands in a banner or a corner.
 */
const TONE_FRAME: Record<ToastTone, string> = {
  info: 'border-border',
  success: 'border-success/40',
  warning: 'border-warning/40',
  danger: 'border-destructive/40',
}

const TONE_ICON: Record<ToastTone, string> = {
  info: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
}

function ToastItem({ record }: { record: ToastRecord }) {
  const Icon = ICONS[record.tone]
  const { text } = useI18n()
  return (
    <div
      // A refusal interrupts; a confirmation does not. `alert` is an assertive
      // live region and is reserved for the two tones an operator must not miss;
      // `status` announces the other two when the reader next comes up for air.
      role={record.sticky ? 'alert' : 'status'}
      data-testid="toast"
      data-tone={record.tone}
      className={cn(
        'pointer-events-auto grid grid-cols-[auto_1fr_auto] gap-x-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg',
        TONE_FRAME[record.tone],
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', TONE_ICON[record.tone])} />
      <div className="min-w-0 space-y-1">
        <div className="font-medium leading-tight">
          {text(record.title)}
          {/* The same failure raised four times is one toast and a count. The
              count is shown rather than swallowed: "this refused four times" and
              "this refused once" are different stories about the request. */}
          {record.count > 1 ? <span className="ml-1.5 text-xs text-muted-foreground">×{record.count}</span> : null}
        </div>
        {record.detail ? <div className="break-words text-muted-foreground">{text(record.detail)}</div> : null}
        {record.actions?.length ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {record.actions.map((action) => (
              <li key={action}>{text(action)}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {/* A toast that never expires and has no way out is an unremovable one.
          The ones that leave on their own do not need a control, and giving them
          one trains the hand to clear the corner without reading it. */}
      {record.sticky ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={text('Dismiss')}
          data-testid="toast-dismiss"
          onClick={() => dismissToast(record.id)}
        >
          <X className="size-3.5" />
        </Button>
      ) : (
        <span />
      )}
    </div>
  )
}

/**
 * The one viewport, portalled to `document.body`.
 *
 * The portal is not decoration: the shell is a sidebar layout whose panes carry
 * transforms, and a `fixed` element inside a transformed ancestor is positioned
 * against that ancestor rather than the viewport — the corner would drift with
 * the sidebar. Rendering into `body` makes "bottom right of the screen" mean
 * what it says.
 *
 * The container is the live region and it is mounted whether or not there is
 * anything in it: assistive technology announces CHANGES to a region that was
 * already there, so a region created at the same moment as its first message is
 * a region whose first message is never read.
 */
function ToastViewport() {
  const toasts = useToasts()
  const { resolved } = useTheme()
  const { text } = useI18n()

  return createPortal(
    <div
      role="region"
      aria-label={text('Notifications')}
      aria-live="polite"
      data-testid="toasts"
      // The theme is stamped EXPLICITLY. This console runs no theme library and
      // no theme context — `lib/theme.ts` owns the `.dark` class on `<html>`,
      // and this subtree hangs off `document.body`, so what it inherits is
      // whatever that class last did. Naming the resolved theme on the element
      // itself is what makes the toast layer's appearance an assertion something
      // can check rather than an inheritance nobody verified. A stock toaster
      // would instead read a theme library off a context, which is exactly the
      // dependency WikiKit does not carry — so the value is passed in by hand,
      // once, here.
      data-theme={resolved}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col gap-2 p-4 sm:inset-x-auto sm:right-0 sm:w-96"
    >
      {toasts.map((record) => (
        <ToastItem key={record.id} record={record} />
      ))}
    </div>,
    document.body,
  )
}

/**
 * Mounts the one toaster the console has.
 *
 * A mount point and nothing more — the queue lives in the store, so there is no
 * context here, no state and no dismissal schedule to keep in step with it.
 * `toast()` therefore works from a mutation callback, from a component that is
 * already unmounting, and from a route being navigated away from, which is
 * where most of the messages this console was losing come from.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToastViewport />
    </>
  )
}
