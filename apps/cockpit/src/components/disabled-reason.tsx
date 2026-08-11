import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/lib/i18n-context'

/**
 * Why a control is refusing, said where every input can reach it.
 *
 * This console disables an action the session has no scope for — Approve on a
 * change proposal when the session holds only `knowledge:read`, checked before
 * the click rather than after the 403, because a button that always fails is
 * worse than a button that is absent. What is missing is the reason. PAGES.md
 * asks for it ("disabled buttons get a tooltip saying which scope is missing")
 * and a disabled button cannot give one on its own.
 *
 * The span is load-bearing, and it is the whole point of this component. A
 * disabled `<button>` fires NO pointer events at all, so a Tooltip anchored
 * directly to it never opens — the trigger receives nothing to react to. The
 * wrapper is what receives the hover, and `tabIndex={0}` is what lets a keyboard
 * reach an explanation the control itself has no way to give. Without both, the
 * operator most likely to hit the disabled button — the one on a phone at 03:00
 * — gets a dead control and no reason.
 *
 * A native `title=` is not the fallback. CUI-WORDS-2: invisible on touch,
 * unreachable by keyboard, which describes exactly the two cases this exists
 * for.
 *
 * `reason` is nullable and that is the API: pass the reason when there is one,
 * pass `null` when the control is live. When there is nothing to explain the
 * children are returned untouched, so an enabled control carries no extra
 * element, no extra tab stop and no bubble that opens onto nothing.
 */
export function DisabledReason({
  reason,
  label,
  children,
  'data-testid': testId = 'disabled-reason',
}: {
  reason: string | null | undefined
  /** Hover/focus label for an enabled icon-only action. A disabled reason takes precedence. */
  label?: string
  children: ReactNode
  'data-testid'?: string
}) {
  const { text } = useI18n()
  const message = reason ?? label
  if (!message) return <>{children}</>
  return (
    // Its own provider: these wrap buttons inside dialogs and sheets, which
    // mount their own trees, and Radix throws rather than degrades when a
    // Tooltip cannot find one.
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="inline-flex rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent data-testid={testId}>{text(message)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
