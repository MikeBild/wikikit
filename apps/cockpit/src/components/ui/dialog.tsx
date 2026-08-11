'use client'

import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/lib/i18n-context'

/**
 * The vendored Radix Dialog. This file used to be the console's own overlay.
 *
 * What it was: a `role="dialog"` div with `aria-modal="true"` written on it by
 * hand, a backdrop that closed on any `mousedown` that started on it, a Tab
 * cycle implemented over a hand-maintained selector string, and props —
 * `title`, `description`, `size`, `footer`, `busy`, `onClose` — that no shadcn
 * component has. Thirteen modules imported it, so the console's second
 * component stack was not a stray file: it was every modal in the product
 * except the confirmation.
 *
 * What is gone with it, deliberately rather than by omission:
 *
 *  - **Backdrop dismiss on `mousedown`.** A press that begins inside the panel
 *    and ends on the backdrop — a text selection dragged too far, a slider
 *    released past its track — closed the dialog. Radix decides on
 *    `pointerdown` outside *and* gives `onPointerDownOutside`/`onInteractOutside`
 *    to refuse it, which is how the busy dialogs below refuse it.
 *  - **`aria-modal` claimed by hand.** The old panel wrote `aria-modal="true"`
 *    on itself while the rest of the document stayed fully reachable to a screen
 *    reader — the attribute was a claim, not an effect. Radix does not write it
 *    at all: it `aria-hidden`s everything outside the panel, which is the thing
 *    the attribute is meant to describe. `dialog.test.tsx` asserts the page, not
 *    the panel, for exactly that reason.
 *  - **A focus trap over a selector list.** `FOCUSABLE` had to be kept in step
 *    with every control the console grows. Radix's `FocusScope` walks the live
 *    tree instead.
 *  - **Focus restore that fought the caller.** The old effect re-ran whenever a
 *    caller passed a fresh `onClose` arrow, moving the caret out of a controlled
 *    input after the first keystroke. Radix restores on unmount, once.
 *
 * Five local deviations from what `shadcn add dialog` writes, all deliberate:
 *
 *  1. **The close button's test id is derived from the panel's.** Stock renders
 *     the `X` with no `data-testid`, so the one control all eighteen of this
 *     console's dialogs have in common was the one control no browser test could
 *     name. `DialogContent` and `DialogFooter` destructure `data-testid` and
 *     derive the button's from it, exactly as `ui/sheet.tsx` derives `-close`,
 *     `ui/dropzone.tsx` derives `-input` and `ui/progress.tsx` derives `-bar`.
 *  2. **`max-h-[calc(100dvh-2rem)]` and `grid-rows-[auto_minmax(0,1fr)_auto]` on
 *     the panel.** Stock has no height bound at all, and this console puts an
 *     archived source document, a four-step ingest wizard and a proposal's
 *     claim-by-claim diff inside
 *     dialogs — every one of which was taller than the viewport on the machines
 *     this is operated from, and would have run off the bottom with no way to
 *     reach it. Header, body, footer: the middle row is the one that gives, so
 *     a body marked `overflow-y-auto` scrolls while `DialogHeader` and
 *     `DialogFooter` keep their size. Layout only, which is what a className is
 *     allowed to be here.
 *
 *     The row template is not decoration. An earlier version of this note
 *     claimed the cap alone was enough — "a grid item that scrolls has an
 *     automatic minimum size of zero, so the body shrinks" — and measurement
 *     says otherwise: with implicit `auto` rows Chromium sizes each row to its
 *     content and then clips the panel at the cap, so **the body never shrank
 *     and no dialog in this console ever scrolled**. an API-key dialog laid
 *     out 1406px of form inside a 635px panel at 390×667 and put its own Create
 *     button 700px below the fold, unreachable by any gesture: `body` is
 *     `overflow: hidden`, so the overflow was not scrolled to, it was cut off.
 *     two more dialogs lost their footers the same
 *     way. It is the 4.8.0 shell defect, one container in.
 *
 *     Those measurements were taken in a browser, and this repository has no
 *     browser stage — an earlier version of this note cited a
 *     `scripts/validate-cockpit-browser.mjs` that does not exist here, which
 *     made the geometry a claim with nothing behind it. What holds the row
 *     template and the cap in THIS repository is
 *     `test/unit/cockpit-overflow.test.ts`, which asserts the shape rather
 *     than the pixels, and says so.
 *  3. **`*:min-w-0` on the panel — the other axis of the same defect.**
 *     `grid-rows-…` stops a tall dialog from running off the bottom; this stops
 *     a wide one from running off the side. A grid item's automatic minimum
 *     size is its min-content size, so ONE unwrappable descendant — a select
 *     trigger carrying a sentence, a long `<code>` ref — resolves the panel's
 *     single column wider than the panel and everything in that column
 *     overflows it. In 0.5.0 that was 744px of content in a 448px dialog, and
 *     the 312px outside were the warning on the `knowledge:approve` scope.
 *
 *     `min-w-0` on the rows is what makes the panel's width the binding
 *     constraint again, so the give happens inside the content (a select
 *     ellipsizes, a `<pre>` scrolls) instead of in the panel. It is the
 *     container half of the fix; `ui/select.tsx` carries the content half.
 *  4. **`closeDisabled` on `DialogContent`.** A dialog guarding a mutation in
 *     flight refuses to close — the `X` is already inert then, because every
 *     path through it ends at the caller's `onOpenChange`, which returns early
 *     while the request is in the air. A control that looks pressable and does
 *     nothing is its own defect, so the caller says so once and the button
 *     carries it. This is what `busy` disabled on the old header button, and it
 *     is the same thing `confirm.tsx` does to `AlertDialogCancel`.
 *  5. **A default `onCloseAutoFocus` that puts focus back on the opener.** Radix
 *     cancels its own focus restore and focuses `DialogTrigger`'s ref instead —
 *     and no dialog in this console uses a `DialogTrigger`, so the ref is null
 *     and focus lands on `<body>`. The full reasoning is on the handler.
 *
 * `shadcn add dialog` would revert all five.
 */

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  closeDisabled,
  onCloseAutoFocus,
  'data-testid': testId,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  closeDisabled?: boolean
  'data-testid'?: string
}) {
  const { t } = useI18n()
  /**
   * Whatever had focus when this content first rendered — the control the
   * operator pressed to open the dialog.
   *
   * Read during render rather than in an effect, and that ordering is the whole
   * point: React runs every effect in the subtree before this component's own,
   * and Radix's `FocusScope` has already moved focus into the panel by then.
   * At render time `document.activeElement` is still the trigger.
   */
  const opener = React.useRef<HTMLElement | null>(null)
  const retry = React.useRef<number | null>(null)
  // Deliberate render-time read; by effect time Radix's FocusScope has already
  // moved focus into the panel — the doc comment above is the full argument.
  // eslint-disable-next-line react-hooks/refs
  if (opener.current === null && typeof document !== 'undefined') {
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
  }
  React.useEffect(
    () => () => {
      if (retry.current !== null) window.clearTimeout(retry.current)
    },
    [],
  )

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-testid={testId}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none *:min-w-0 sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        /**
         * Put focus back on the control that opened this — the fifth
         * deviation, and the one that is a bug fix rather than a preference.
         *
         * `FocusScope` remembers the previously focused element and restores it
         * on unmount, so this would normally need no help. What defeats it is
         * one line in `@radix-ui/react-dialog`'s modal content: its own
         * `onCloseAutoFocus` *cancels* that restore (`event.preventDefault()`)
         * and focuses `context.triggerRef.current` instead. That ref is only
         * ever set by `DialogTrigger`, and **not one dialog in this console
         * uses one** — every call site owns its own button so it can own the
         * scope check, the `disabled` and the `data-testid` on it. The ref is
         * `null`, the `?.` swallows the call, the built-in restore has already
         * been cancelled, and focus lands on `<body>`: a keyboard operator who
         * closes a dialog is dropped at the top of the document.
         *
         * A caller that prevents the default keeps full control (that is how
         * `confirm.tsx` runs its own three-shape restore). Otherwise: the
         * trigger, and if it is momentarily `disabled` — `disabled={isPending}`
         * outliving the close by a refetch — once more on the next macrotask,
         * by which time it has re-enabled.
         */
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          if (event.defaultPrevented) return
          const target = opener.current
          if (!target?.isConnected) return
          event.preventDefault()
          target.focus()
          if (document.activeElement === target) return
          retry.current = window.setTimeout(() => {
            retry.current = null
            // Anything else having taken focus meanwhile is a deliberate move —
            // a reopened dialog, a toast action — and is never stolen from.
            if (document.activeElement !== null && document.activeElement !== document.body) return
            if (target.isConnected) target.focus()
          }, 0)
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <Tooltip>
            <TooltipTrigger asChild>
              <DialogPrimitive.Close data-slot="dialog-close" asChild>
                <Button
                  variant="ghost"
                  className="absolute top-2 right-2"
                  size="icon-sm"
                  disabled={closeDisabled}
                  aria-label={t('common.close')}
                  data-testid={testId ? `${testId}-close` : 'dialog-close'}
                >
                  <XIcon />
                </Button>
              </DialogPrimitive.Close>
            </TooltipTrigger>
            <TooltipContent data-testid={testId ? `${testId}-close-tooltip` : 'dialog-close-tooltip'}>
              {t('common.close')}
            </TooltipContent>
          </Tooltip>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  'data-testid': testId,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
  'data-testid'?: string
}) {
  return (
    <div
      data-slot="dialog-footer"
      data-testid={testId}
      className={cn(
        '-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline" data-testid={testId ? `${testId}-close` : 'dialog-footer-close'}>
            Close
          </Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-heading text-base leading-none font-medium', className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
