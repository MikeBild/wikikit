import { cn } from '@/lib/utils'

/**
 * A row of mutually exclusive filter choices — the review queue's
 * pending/decided split, a status filter on the ingest jobs list.
 *
 * Real `<button>`s with `aria-pressed`, not styled divs (CUI-ACT-3), and a
 * `role="group"` with a name so a screen reader announces the row as one
 * control. This is a FILTER, which changes what is shown and nothing else; a
 * control that records a decision belongs in a Button with a confirm dialog,
 * never here.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  'data-testid': testId,
}: {
  value: T
  options: readonly { id: T; label: string }[]
  onChange: (id: T) => void
  label: string
  'data-testid'?: string
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-border p-0.5"
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          data-testid={testId ? `${testId}-${option.id}` : undefined}
          className={cn(
            'rounded-[6px] px-2 py-1 text-xs transition-colors',
            value === option.id
              ? 'bg-secondary text-secondary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
