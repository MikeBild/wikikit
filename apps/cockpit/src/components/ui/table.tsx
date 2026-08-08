'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The one local deviation from what `shadcn add table` writes: below `md`, a
 * row's last cell is pinned to the right edge of the scroller.
 *
 * Measured at 390, every list in this console: the tables are 713px (spaces) to
 * 1749px (webhook endpoints) wide inside a 342px container, and **the last
 * column is the row's actions on every one of them**. So `edit`, `revoke`,
 * `delete`, `approve` and `expand` sat between 370px and 1400px off the right
 * of the window — reachable only by scrolling a table sideways first, on a
 * surface where that gesture is also how you scroll the page. On a phone the
 * cockpit was read-only by accident, which for a product whose whole point is
 * that a human approves every change is the one thing it cannot be.
 *
 * UI-UX.md §7 lets a table scroll horizontally, and this keeps that: the data
 * still scrolls, in full, with nothing hidden. What stops scrolling is the
 * column that is not data. `md` rather than `sm` because 768px is the console's
 * own breakpoint — `useIsMobile`, the sidebar sheet and this now change shape
 * at the same width — and above it nothing about a table changes at all.
 *
 * `max-w-36` and `flex-wrap` are the other half, and they are what a first
 * attempt without them measured: pinned but unbounded, the identities list's
 * three controls ("Edit", "Revoke sessions", "Delete") held 230px of a 342px
 * window open permanently and cut the identity's name to 110px at *every*
 * scroll position — the column that says whose access is being revoked.
 * Bounded, that cell is 139px, the name gets 219px, and the three controls
 * stack. Cells whose actions already fit are untouched: `concepts` is 62px,
 * `sources` 16px.
 *
 * `:last-child` rather than a marker class because the alternative is a prop
 * threaded through ten call sites that all already put their actions last; the
 * structure is the signal, and the narrow-viewport case in
 * `test/unit/cockpit-overflow.test.ts` is what checks it stays true.
 */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn(
          // `min-w-full`, NOT `w-full`, and the difference is a rendering bug
          // this console shipped on every table it has.
          //
          // `width: 100%` caps the table at its container, so the container's
          // `overflow-x-auto` never has anything to scroll. A table whose
          // natural width exceeds the viewport does not scroll — the browser
          // squeezes the columns instead, and once they cannot squeeze further
          // the cell contents run over each other. On the lint findings list
          // that produced a claim's quoted citation rendered underneath the
          // finding column, which is how it was reported: two sentences
          // overlapping in one row — and a citation you cannot read is a
          // citation that is not doing its job.
          //
          // `min-width: 100%` keeps a short table filling the card and lets a
          // wide one grow past it, which is the case the scroll container was
          // added for. It also makes the overflow check's "N scrolling inside"
          // mean something: with `w-full` no table could ever scroll, so a green
          // run was measuring the bug rather than the absence of it.
          'min-w-full caption-bottom text-sm',
          'max-md:[&_tr>:last-child]:sticky max-md:[&_tr>:last-child]:right-0 max-md:[&_tr>:last-child]:max-w-36 max-md:[&_tr>:last-child]:flex-wrap max-md:[&_tr>:last-child]:bg-card',
          className,
        )}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0', className)}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption data-slot="table-caption" className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} />
  )
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption }
