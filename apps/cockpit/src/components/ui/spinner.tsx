import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n-context'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  const { text } = useI18n()
  return (
    <LoaderCircle role="status" aria-label={text('Loading')} className={cn('animate-spin', className)} {...props} />
  )
}

export { Spinner }
