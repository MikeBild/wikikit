import { useQuery } from '@tanstack/react-query'
import { keys, wk } from '@/api/wk'
import { Shell } from '@/app/shell'
import { EmptyState } from '@/components/empty-state'
import { Alert } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/lib/session'
import { SpaceProvider } from '@/components/space-provider'

interface SpaceRow {
  slug: string
}

/**
 * The root route: resolve which wikis exist, then render the shell inside them.
 *
 * WHY this sits above the shell rather than inside it: every page addresses a
 * wiki, and a page that renders before the list is known would either fetch
 * `/v1/spaces/undefined/...` or have to carry its own guard. One resolution
 * point, one guard, and `useSpace()` can be non-nullable everywhere below.
 *
 * The list is deliberately not on `staleTime: Infinity`: a wiki created in
 * another tab should appear here without a reload, and the query layer's 15s
 * default is short enough for that and long enough not to refetch on every
 * navigation.
 */
export function Root() {
  const session = useSession()
  const query = useQuery({ queryKey: keys.spaces(), queryFn: () => wk.spaces.list() })

  if (query.isPending) {
    return (
      <div className="flex h-full flex-col gap-3 p-6" data-testid="root-loading">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
    )
  }

  if (query.error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Alert tone="danger" title="Could not list wikis" className="max-w-md">
          {query.error instanceof Error ? query.error.message : 'The spaces endpoint did not answer.'}
        </Alert>
      </div>
    )
  }

  // `items`, not `spaces` — every list read in this API answers `{items: [...]}`
  // (zSpaceListResponse). Reading the wrong key produced an empty array and an
  // installation with two wikis rendered "No wikis yet", which is the exact
  // shape of failure an optional chain hides: no error, no empty response, just
  // a page quietly claiming nothing exists.
  const spaces = (query.data?.items ?? []).map((row: SpaceRow) => row.slug)

  // No wiki at all is a real state, not an error: a fresh installation has
  // none until somebody creates one, and an empty console that says so beats
  // an empty console that looks broken.
  if (spaces.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          title="No wikis yet"
          description="A wiki holds pages, the sources behind them and the changes waiting for review. Create one over the API to get started."
        />
      </div>
    )
  }

  // A space-bound credential can only ever read one wiki, so the switcher is
  // not offered — and the slug comes from the list rather than from the
  // session, which carries the space id and not its slug.
  const lockedTo = session.space_id ? (spaces[0] ?? null) : null

  return (
    <SpaceProvider available={spaces} lockedTo={lockedTo}>
      <Shell />
    </SpaceProvider>
  )
}
