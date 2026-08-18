import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  retainSearchParams,
} from '@tanstack/react-router'
import { Root } from '@/app/root'
import { NotFoundPage } from '@/pages/not-found'

/**
 * A CODE-BASED route tree, not a generated one.
 *
 * The file-based generator writes a routeTree.gen.ts that has to be committed
 * and kept in step by a plugin, which means the router's shape lives in a file
 * nobody edits and a build step nobody can read. This tree is a dozen routes;
 * the generator's whole value proposition is scale this console does not have,
 * and its cost — a generated artifact in the repository, a watcher in the dev
 * server — is paid immediately.
 *
 * Deliberately NO helper around createRoute: a `page(path, component)` helper
 * would widen every path literal to `string`, and the literal is load-bearing
 * twice — TanStack's typed `Link` derives its `to` union from these literals,
 * and test/unit/cockpit-navigation.test.ts greps this file for the path
 * literals to prove every routed page is reachable from the navigation table.
 *
 * Every component is lazy so one page's weight stays out of another's first
 * paint — which matters most for the two pages that pull in the Markdown
 * renderer. Detail routes live flat under the root with their full path.
 *
 * basepath is `/cockpit` because WikiKit serves it there. It appears here once
 * rather than in every link.
 */
const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: NotFoundPage,
  /**
   * `?space=` is the address of the wiki being read, so it is validated here
   * and inherited by every route rather than re-declared on each one.
   *
   * An unrecognised parameter is DROPPED, not rejected: analytics tags,
   * `utm_*` and whatever a chat client appends to a pasted link must not turn
   * a shared page into an error screen.
   */
  validateSearch: (search: Record<string, unknown>): { space?: string } => {
    const space = search.space
    return typeof space === 'string' && space ? { space } : {}
  },
  /**
   * `?space=` survives every navigation, and this is the ONLY thing that makes
   * it so.
   *
   * A `<Link>` with no `search` prop does not inherit the current one — the
   * router treats a missing `search` as an empty one and the query string is
   * dropped. So clicking Pages in the sidebar while reading `?space=team-b`
   * landed on `/cockpit/pages` with no space at all, the resolver fell through
   * to the first wiki the credential could see, and the reader was silently
   * moved into a DIFFERENT wiki — sidebar, page body and every subsequent
   * request — with nothing on screen saying so.
   *
   * Declared once here rather than as a `search={(prev) => prev}` prop on every
   * link: three pages had remembered to do that and fourteen link sites had
   * not, which is exactly the failure mode a per-call-site convention has.
   */
  search: { middlewares: [retainSearchParams(['space'])] },
})

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: lazyRouteComponent(() => import('@/pages/home'), 'HomePage'),
})
/**
 * The four named places of the loop, in the order the sidebar reads them.
 * `/answers/$id` is a detail route under its index, like `/pages/$slug`: an
 * answer somebody wants a second opinion on is a link you can send.
 */
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: lazyRouteComponent(() => import('@/pages/inbox'), 'InboxPage'),
})
const answersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/answers',
  component: lazyRouteComponent(() => import('@/pages/answers'), 'AnswersPage'),
})
const answerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/answers/$id',
  component: lazyRouteComponent(() => import('@/pages/answer'), 'AnswerPage'),
})
const careRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/care',
  component: lazyRouteComponent(() => import('@/pages/care'), 'CarePage'),
})
const pagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pages',
  component: lazyRouteComponent(() => import('@/pages/pages'), 'PagesPage'),
})
const pageNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pages/new',
  component: lazyRouteComponent(() => import('@/pages/page-edit'), 'PageEditPage'),
})
const pageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pages/$slug',
  component: lazyRouteComponent(() => import('@/pages/page'), 'PageDetailPage'),
})
/**
 * Editing is its own ADDRESS, not a mode a component remembers.
 *
 * `/cockpit/pages/onboarding/edit` is the link somebody sends when they mean
 * "please fix this paragraph". A pencil that only toggles local state cannot be
 * sent, bookmarked or reloaded, and the half-typed draft dies on the first
 * accidental navigation with nothing on screen having warned about it.
 */
const pageEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pages/$slug/edit',
  component: lazyRouteComponent(() => import('@/pages/page-edit'), 'PageEditPage'),
})
const decisionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/decisions',
  component: lazyRouteComponent(() => import('@/pages/decisions'), 'DecisionsPage'),
})
const proposalReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/decisions/proposals/$id',
  component: lazyRouteComponent(() => import('@/pages/proposal-review'), 'ProposalReviewPage'),
})
const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sources',
  component: lazyRouteComponent(() => import('@/pages/sources'), 'SourcesPage'),
})
const sourceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sources/$id',
  component: lazyRouteComponent(() => import('@/pages/source'), 'SourcePage'),
})
const decisionLogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/decision-log',
  component: lazyRouteComponent(() => import('@/pages/decision-log'), 'DecisionLogPage'),
})
const decisionLogDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/decision-log/$slug',
  component: lazyRouteComponent(() => import('@/pages/decision-log-detail'), 'DecisionLogDetailPage'),
})
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  component: lazyRouteComponent(() => import('@/pages/search'), 'SearchPage'),
})
const charterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/charter',
  component: lazyRouteComponent(() => import('@/pages/charter'), 'CharterPage'),
})
const spacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/spaces',
  component: lazyRouteComponent(() => import('@/pages/spaces'), 'SpacesPage'),
})
const apiKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/api-keys',
  component: lazyRouteComponent(() => import('@/pages/api-keys'), 'ApiKeysPage'),
})
const identitiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/identities',
  component: lazyRouteComponent(() => import('@/pages/identities'), 'IdentitiesPage'),
})
const webhooksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/webhooks',
  component: lazyRouteComponent(() => import('@/pages/webhooks'), 'WebhooksPage'),
})
const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/system',
  component: lazyRouteComponent(() => import('@/pages/system'), 'SystemPage'),
})
const modelUsageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/model-usage',
  component: lazyRouteComponent(() => import('@/pages/model-usage'), 'ModelUsagePage'),
})

const routeTree = rootRoute.addChildren([
  homeRoute,
  inboxRoute,
  pagesRoute,
  // Before the $slug route: '/pages/new' would otherwise resolve as a page
  // whose slug is the word "new".
  pageNewRoute,
  pageRoute,
  pageEditRoute,
  decisionsRoute,
  proposalReviewRoute,
  answersRoute,
  answerRoute,
  careRoute,
  sourcesRoute,
  sourceRoute,
  decisionLogRoute,
  decisionLogDetailRoute,
  searchRoute,
  charterRoute,
  spacesRoute,
  apiKeysRoute,
  identitiesRoute,
  webhooksRoute,
  modelUsageRoute,
  systemRoute,
])

export const router = createRouter({ routeTree, basepath: '/cockpit' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
