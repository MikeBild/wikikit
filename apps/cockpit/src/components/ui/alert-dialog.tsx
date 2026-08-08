'use client'

import type { ComponentProps } from 'react'
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * The vendored Radix AlertDialog — the second dialog primitive in this console,
 * on purpose.
 *
 * `ui/dialog.tsx` is the one for a surface with work in it: an editor, a
 * wizard, a rendered document. This one is for a surface with a *question* in
 * it, and the difference between them is not decoration:
 *
 *  - **No light-dismiss, at all.** `Dialog` closes on a pointer-down outside the
 *    panel, which is right for a form the operator opened to read. It is wrong
 *    for a decision. An approval that a click on the page behind it can answer
 *    is not an approval, and `AlertDialog` does not offer the behaviour to be
 *    turned off — it never had it. Radix's own content already prevents
 *    `onInteractOutside`; `confirm.tsx` prevents it again and says why.
 *  - **No `X`.** `Dialog` renders a close button in the corner, because a
 *    surface you opened to read needs a way out that is not a decision. Here the
 *    ways out are the two controls in the footer and the Escape key, and a third
 *    unlabelled one in the corner would be a third answer to a two-answer
 *    question. That is also why `showCloseButton` is absent rather than
 *    defaulted to `false`: a prop that can be passed is a prop somebody passes.
 *  - **`role="alertdialog"`**, which a reader announces differently and which
 *    tells it to read the description immediately rather than on request.
 *
 * Three local deviations from what `shadcn add alert-dialog` writes:
 *
 *  1. **`Action` and `Cancel` take the console's `Button`, not a class string.**
 *     Stock reaches for the exported `buttonVariants`; `ui/button.tsx`
 *     deliberately does not export it (a module exporting a component and a
 *     helper defeats fast refresh, and `eslint-plugin-react-refresh` is on for
 *     this app). `asChild` composes Radix's behaviour onto the real component
 *     instead, so a destructive confirm is the same red as every other
 *     destructive button in the console rather than a second opinion about it.
 *  2. **`max-h` and `grid-rows-[auto_minmax(0,1fr)_auto]` on the panel**, copied
 *     from `ui/dialog.tsx` along with the measurement behind it: with implicit
 *     `auto` rows the browser sizes each row to its content and then clips the
 *     panel at the cap, so the body never shrinks and nothing ever scrolls —
 *     the footer simply leaves the screen, and `body` is `overflow: hidden`, so
 *     it is cut off rather than scrolled past. A confirmation whose Confirm
 *     button is below the fold at 390px is a confirmation that cannot be given.
 *     Header, body, footer: the middle row is the one that gives.
 *  3. **`data-testid` on `Content` and `Footer` is the caller's**, matching the
 *     convention `ui/dialog.tsx` and `ui/sheet.tsx` already follow, so every
 *     interactive element in here can be named (`CUI-A11Y-4`).
 */

function AlertDialog({ ...props }: ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogPortal({ ...props }: ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
}

function AlertDialogOverlay({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  )
}

function AlertDialogContent({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert-dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />
}

function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        '-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('font-heading text-base leading-none font-medium', className)}
      {...props}
    />
  )
}

function AlertDialogDescription({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

function AlertDialogAction({ variant = 'default', size = 'sm', ...props }: ComponentProps<typeof Button>) {
  return (
    <AlertDialogPrimitive.Action asChild>
      <Button data-slot="alert-dialog-action" variant={variant} size={size} {...props} />
    </AlertDialogPrimitive.Action>
  )
}

function AlertDialogCancel({ variant = 'outline', size = 'sm', ...props }: ComponentProps<typeof Button>) {
  return (
    <AlertDialogPrimitive.Cancel asChild>
      <Button data-slot="alert-dialog-cancel" variant={variant} size={size} {...props} />
    </AlertDialogPrimitive.Cancel>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
}
