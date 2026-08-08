import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { askingAgainCouldHelp } from '@/lib/failure'

/**
 * One client for the tab.
 *
 * `retry` is the setting that matters. The default retries everything three
 * times, which for a 403 means three identical refusals and a three-second wait
 * before the operator is told the thing they cannot do. WikiKit's own error
 * contract says it out loud: a 401 means retry authentication, a 403 means stop
 * and ask for a scope — `knowledge:review` or `knowledge:approve`, and no
 * amount of asking again will mint one — and a 404 means the route table will
 * not change. The console obeys it, through `askingAgainCouldHelp`, the same
 * function the error banner uses to decide whether to offer a Try again button,
 * so the transport and the surface can never disagree about which refusals are
 * final.
 *
 * `refetchOnWindowFocus` is off on purpose: a review queue that silently
 * refetches on every tab switch fights the SSE change stream planned to replace
 * polling, and a surprise refetch under a confirm dialog is how an operator
 * approves the proposal that just moved.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => {
          if (error instanceof ApiError && !askingAgainCouldHelp(error.status)) return false
          return count < 2
        },
        refetchOnWindowFocus: false,
        staleTime: 15_000,
      },
      mutations: { retry: false },
    },
  })
}
