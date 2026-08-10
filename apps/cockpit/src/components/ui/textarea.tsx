import * as React from 'react'

import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n-context'

function Textarea({
  className,
  placeholder,
  title,
  'aria-label': ariaLabel,
  ...props
}: React.ComponentProps<'textarea'>) {
  const { text } = useI18n()
  return (
    <textarea
      data-slot="textarea"
      placeholder={typeof placeholder === 'string' ? text(placeholder) : placeholder}
      title={typeof title === 'string' ? text(title) : title}
      aria-label={typeof ariaLabel === 'string' ? text(ariaLabel) : ariaLabel}
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
