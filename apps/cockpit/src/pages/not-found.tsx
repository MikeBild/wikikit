import { Link } from '@tanstack/react-router'
import { Map } from 'lucide-react'
import { Page } from '@/app/shell'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

export function NotFoundPage() {
  return (
    <Page title="Page not found" description="This address is not part of the current cockpit.">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Map />
          </EmptyMedia>
          <EmptyTitle>The page no longer exists</EmptyTitle>
          <EmptyDescription>Use the current navigation or return to the overview.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link to="/" data-testid="not-found-home">
              Return to overview
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    </Page>
  )
}
