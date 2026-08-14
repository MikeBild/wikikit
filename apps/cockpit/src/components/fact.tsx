import { I18nText } from '@/components/i18n-text'

/** One number inside a card, where a second card would nest (CUI-LADDER-2). */
export function Fact({ testId, label, value, hint }: { testId: string; label: string; value: string; hint?: string }) {
  return (
    <I18nText>
      <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
        <dt className="text-muted-foreground text-xs">{label}</dt>
        <dd className="text-base font-medium tabular-nums">{value}</dd>
        {hint ? <dd className="text-muted-foreground truncate text-xs">{hint}</dd> : null}
      </div>
    </I18nText>
  )
}
