import { Inbox, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { I18nText } from '@/components/i18n-text'
import { useI18n } from '@/lib/i18n-context'
import { cn } from '@/lib/utils'

/**
 * The empty state, with the three things CUI-LOAD-3 requires: a title, a
 * description, and — where one exists — the action that fills it.
 *
 * `components/ui/empty.tsx` has been vendored since the console was scaffolded
 * and is imported by exactly zero pages, so every empty branch in this bundle is
 * currently one muted sentence inside a dashed box: "No pages." A reader
 * meeting that has to work out on their own whether this space has never had a
 * concept page, whether their filter excluded them all, or whether they are
 * allowed to propose one. The title says which world they are in, the
 * description says why it is empty, and the action is the way out — which is the
 * same rule the console already applies to dead ends elsewhere ("every dead end
 * gets a route forward, or says who owns the exit").
 *
 * An empty state is not a failure and must not look like one (CUI-LOAD-4): no
 * severity colour, no alert role. An empty review queue is GOOD NEWS — every
 * change proposal has been decided. Where the emptiness IS a refusal in
 * disguise — a capability the deployment never bound — the description is the
 * place to say so plainly, and `action` is left off rather than offering a
 * button that answers 501.
 *
 * The action is a node the page owns, because only the page knows whether the
 * session may take it. A page gating on scope composes the two:
 *
 *   <EmptyState
 *     title="No pages yet"
 *     description="A concept page states what this space knows, and every claim on it carries a verbatim quote from a source."
 *     action={
 *       <DisabledReason reason={can('knowledge:propose') ? null : 'Needs knowledge:propose'}>
 *         <Button disabled={!can('knowledge:propose')} data-testid="new-page">New page</Button>
 *       </DisabledReason>
 *     }
 *   />
 *
 * One action, not a row of them (CUI-ACT-4). If a surface has two ways out, the
 * empty state names the one that fills it and the page carries the other.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  framed = true,
  className,
  'data-testid': testId = 'empty-state',
}: {
  /** Lucide icon. The default is deliberately dull — an empty state is not an event. */
  icon?: LucideIcon
  /** Which world the reader is in: "No pages yet", "No results for this filter". */
  title: string
  /** Why it is empty, and what would change that. One or two sentences. */
  description: ReactNode
  /** The action that fills it, when the operator has one. Omitted, not disabled-and-unexplained. */
  action?: ReactNode
  /**
   * The dashed frame. On by default; off when this sits inside a container that
   * already draws one — a card, or a table body — because two dashed rectangles
   * around one sentence is the "cards do not nest" defect (CUI-LADDER-2).
   */
  framed?: boolean
  className?: string
  'data-testid'?: string
}) {
  const { text } = useI18n()
  return (
    <Empty
      data-testid={testId}
      // `border-dashed` alone paints nothing: the vendored primitive names the
      // STYLE of the border and leaves its width to the caller. The width lives
      // here rather than in the vendored file so that file stays a byte-for-byte
      // copy of the upstream primitive and can be re-vendored without a merge.
      className={cn(framed && 'border border-dashed', className)}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle data-testid={`${testId}-title`}>{text(title)}</EmptyTitle>
        <EmptyDescription data-testid={`${testId}-description`}>
          <I18nText>{description}</I18nText>
        </EmptyDescription>
      </EmptyHeader>
      {action ? (
        <EmptyContent data-testid={`${testId}-action`}>
          <I18nText>{action}</I18nText>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
