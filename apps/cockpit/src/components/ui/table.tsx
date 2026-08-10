'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * shadcn's scroll container remains as a defensive boundary, but the cockpit's
 * responsive contract is stricter: below `md` the table itself fits the card.
 * `DataTable` removes secondary columns, while fixed layout plus wrapping keeps
 * the remaining identity, state and action cells inside the viewport.
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
          'min-w-full caption-bottom text-sm max-md:w-full max-md:table-fixed',
          'max-md:[&_tr>:last-child]:max-w-36 max-md:[&_tr>:last-child]:flex-wrap',
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
        'h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground max-md:break-words max-md:whitespace-normal [&:has([role=checkbox])]:pr-0',
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
      className={cn(
        'p-2 align-middle whitespace-nowrap max-md:break-words max-md:whitespace-normal [&:has([role=checkbox])]:pr-0',
        className,
      )}
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
