import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Values that exist exactly once or are painful to select by hand — a raw API
 * key, a source id, a request id — have to be copyable without dragging a
 * selection across a table cell. `navigator.clipboard` needs a secure context,
 * so the failure is reported rather than swallowed: silently copying nothing is
 * how a key is lost.
 *
 * `size="icon-sm"` rather than `"icon"`: the labelled form is `sm` (`h-7`), and
 * the icon-only form has to be the same height, or two copy buttons in one row
 * sit at two different sizes.
 */
export function CopyButton({
  value,
  label = 'Copy',
  size = 'sm',
  'data-testid': testId = 'copy-button',
}: {
  value: string
  label?: string
  size?: 'sm' | 'icon-sm'
  'data-testid'?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      data-testid={testId}
      aria-label={size === 'icon-sm' ? label : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setState('copied')
        } catch {
          setState('failed')
        }
        setTimeout(() => setState('idle'), 2000)
      }}
    >
      {/* No size class: the Button CVA sizes an unsized svg per button size, so
          the glyph tracks `sm` and `icon-sm` on its own. `data-icon` only where
          there is a label beside it — it is what tightens the padding on that
          side, and an icon-only button has no side to tighten. */}
      {state === 'copied' ? (
        <Check data-icon={size === 'icon-sm' ? undefined : 'inline-start'} />
      ) : (
        <Copy data-icon={size === 'icon-sm' ? undefined : 'inline-start'} />
      )}
      {size === 'icon-sm'
        ? null
        : state === 'failed'
          ? 'Copy blocked — select it'
          : state === 'copied'
            ? 'Copied'
            : label}
    </Button>
  )
}
