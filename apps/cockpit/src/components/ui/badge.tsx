import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * The registry badge's geometry, with WikiKit's meanings.
 *
 * The base classes, the size, the radius, the icon handling and the focus ring
 * are the registry's, so a badge here is still the registry's object and a
 * component pasted in from it keeps working. The variant table is NOT: shadcn
 * ships `default|secondary|destructive|outline|ghost|link`, which are
 * *appearances*, and this cockpit needs *severities* — a proposal that was
 * rejected, a claim whose citation no longer resolves, a lint finding.
 *
 * That distinction is the whole reason this file diverges rather than being
 * copied. A `variant="default"` sitting in a row beside a `tone="success"` is
 * two grammars on one screen — a badge that means "primary" next to a badge that
 * means "approved", rendering as siblings and meaning nothing alike. It is
 * precisely the "console nobody decided" defect this cockpit's style guide opens
 * by describing, and adding shadcn's names alongside these would import it.
 *
 * The prop is `tone`, not `variant`, so the difference is impossible to use by
 * accident: a pasted `variant="destructive"` is a type error rather than a badge
 * that silently means something else.
 */
const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-secondary text-secondary-foreground',
        // Severity tones name the severity, never the chart series they happen
        // to share a hex with. `bg-chart-3` on a warning badge renders
        // identically and reads as though a graph leaked into a status pill.
        success: 'border-transparent bg-success/15 text-success',
        warning: 'border-transparent bg-warning/15 text-warning',
        danger: 'border-transparent bg-destructive/15 text-destructive',
        accent: 'border-transparent bg-accent/15 text-accent',
        // The fourth state, and the one every other dashboard omits: a thing
        // WikiKit has not established. A concept whose claims nobody has linted
        // yet, a source whose ingest has not run, a coverage gap nobody has
        // measured — visibly present, visibly not a measurement.
        //
        // Dashed, muted, and deliberately NOT green and NOT red. A knowledge
        // base that renders "not checked yet" as verified is lying, and one that
        // renders it as a lint failure cries wolf; `lib/tokens.ts`'s STATE_TOKEN
        // encodes the same rule for the SVG side, where a Tailwind class cannot
        // reach.
        unknown: 'border-dashed border-muted-foreground/40 text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }

export function Badge({ className, tone = 'neutral', asChild = false, ...props }: BadgeProps) {
  const Component = asChild ? Slot.Root : 'span'
  return <Component data-slot="badge" data-tone={tone} className={cn(badgeVariants({ tone }), className)} {...props} />
}
