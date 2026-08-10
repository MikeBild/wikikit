import { CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'
import { I18nText } from '@/components/i18n-text'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/lib/i18n-context'

/**
 * Supplemental product explanation that works with mouse, keyboard and touch.
 *
 * The short tooltip names the icon on hover/focus. The longer explanation is a
 * click-open popover, so it is never trapped behind hover on a phone. Essential
 * state and consequences stay in the page or confirmation dialog instead.
 */
export function ContextHelp({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  const { text } = useI18n()
  const label = text(title)
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={label} data-testid={`${testId}-trigger`}>
              <CircleHelp />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" data-testid={`${testId}-content`}>
        <PopoverHeader>
          <PopoverTitle>
            <I18nText>{title}</I18nText>
          </PopoverTitle>
        </PopoverHeader>
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <I18nText>{children}</I18nText>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A shadcn field label with supplemental guidance beside it. */
export function FieldLabel({
  htmlFor,
  children,
  help,
  helpTitle,
  testId,
}: {
  htmlFor?: string
  children: ReactNode
  help: ReactNode
  helpTitle: string
  testId: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>
        <I18nText>{children}</I18nText>
      </Label>
      <ContextHelp title={helpTitle} testId={testId}>
        {help}
      </ContextHelp>
    </div>
  )
}

/** A section label with optional supplemental explanation beside it. */
export function SectionHeading({
  id,
  children,
  help,
  helpTitle,
  testId,
}: {
  id?: string
  children: ReactNode
  help?: ReactNode
  helpTitle?: string
  testId: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <h2 id={id} className="text-sm font-semibold">
        <I18nText>{children}</I18nText>
      </h2>
      {help && helpTitle ? (
        <ContextHelp title={helpTitle} testId={testId}>
          {help}
        </ContextHelp>
      ) : null}
    </div>
  )
}
