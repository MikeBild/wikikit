import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return <LoaderCircle role="status" aria-label="Loading" className={cn('animate-spin', className)} {...props} />
}

export { Spinner }
