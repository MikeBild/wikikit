import { cva, type VariantProps } from 'class-variance-authority'
import { AlertTriangle, Info, OctagonAlert, X } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'

const alertVariants = cva('relative w-full rounded-lg border p-3 text-sm grid grid-cols-[auto_1fr_auto] gap-x-3', {
  variants: {
    tone: {
      info: 'border-border bg-card text-card-foreground',
      warning: 'border-warning/40 bg-warning/10 text-foreground',
      danger: 'border-destructive/40 bg-destructive/10 text-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
})

const ICONS = { info: Info, warning: AlertTriangle, danger: OctagonAlert } as const

export type AlertProps = ComponentProps<'div'> &
  VariantProps<typeof alertVariants> & {
    title: string
    /** Terminal instructions from the server's `next_best_actions`. Rendered, never dropped. */
    actions?: readonly string[]
    children?: ReactNode
    /**
     * Only `info` may ever be dismissed, and only when the caller says so.
     *
     * A warning or an error that disappears on its own is a fact the operator
     * did not get to read. Toasts that auto-dismiss are how "this concept's
     * source was re-archived and its claims no longer quote it" becomes
     * "nobody mentioned it".
     */
    dismissible?: boolean
  }

export function Alert({ className, tone = 'info', title, actions, children, dismissible, ...props }: AlertProps) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  const Icon = ICONS[tone ?? 'info']
  const canDismiss = dismissible && tone === 'info'
  return (
    <div role="alert" className={cn(alertVariants({ tone }), className)} {...props}>
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'danger' && 'text-destructive',
          tone === 'warning' && 'text-warning',
          tone === 'info' && 'text-muted-foreground',
        )}
      />
      <div className="min-w-0 space-y-1">
        <div className="font-medium leading-tight">{title}</div>
        {children ? <div className="text-muted-foreground break-words">{children}</div> : null}
        {actions?.length ? (
          // The server said what to do instead of retrying. An error banner
          // that drops that on the floor turns a terminal instruction back
          // into a mystery.
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {canDismiss ? (
        <Button variant="ghost" size="icon" className="size-6" aria-label="Dismiss" onClick={() => setDismissed(true)}>
          <X className="size-3.5" />
        </Button>
      ) : (
        <span />
      )}
    </div>
  )
}
