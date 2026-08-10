import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

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
    <ToggleGroup
      type="single"
      value={value}
      variant="outline"
      size="sm"
      spacing={0}
      aria-label={label}
      data-testid={testId}
      onValueChange={(next) => {
        if (next) onChange(next as T)
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.id} value={option.id} data-testid={testId ? `${testId}-${option.id}` : undefined}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
