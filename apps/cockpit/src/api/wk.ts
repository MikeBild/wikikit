import { api, unwrap, unwrapAs } from './client'

/**
 * The whole API surface the console reaches, in one object.
 *
 * WHY a facade rather than `api.GET(...)` at each call site: a page that spells
 * out its own paths is a page that can drift from the server without anything
 * noticing, and `app/nav.ts` declares which paths each page is allowed to reach
 * — a declaration only worth making if there is one place to compare it
 * against. Pages call `wk.*`; nothing else calls `api` directly.
 *
 * `keys` sits next to it so a mutation invalidates by the same name the query
 * was registered under. Two hand-written key arrays that must match is exactly
 * the bug where a list silently keeps showing the row somebody just deleted.
 */
export const wk = {
  spaces: {
    list: () => unwrap(api.GET('/v1/spaces')),
    get: (space: string) => unwrap(api.GET('/v1/spaces/{space}', { params: { path: { space } } })),
    create: (body: { slug: string; name: string; purpose?: string }) =>
      unwrapAs<{ slug: string }>(api.POST('/v1/spaces', { body: body as never })),
    settings: (space: string, body: Record<string, unknown>) =>
      unwrapAs<unknown>(api.POST('/v1/spaces/{space}/settings', { params: { path: { space } }, body: body as never })),
  },

  concepts: {
    list: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/concepts', { params: { path: { space }, query: query as never } })),
    get: (space: string, slug: string) =>
      unwrap(api.GET('/v1/spaces/{space}/concepts/{slug}', { params: { path: { space, slug } } })),
    history: (space: string, slug: string) =>
      unwrap(api.GET('/v1/spaces/{space}/concepts/{slug}/history', { params: { path: { space, slug } } })),
  },

  decisions: {
    list: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/decisions', { params: { path: { space }, query: query as never } })),
    get: (space: string, slug: string) =>
      unwrap(api.GET('/v1/spaces/{space}/decisions/{slug}', { params: { path: { space, slug } } })),
  },

  sources: {
    list: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/sources', { params: { path: { space }, query: query as never } })),
    get: (space: string, id: string) =>
      unwrap(api.GET('/v1/spaces/{space}/sources/{id}', { params: { path: { space, id } } })),
    streams: (space: string) => unwrap(api.GET('/v1/spaces/{space}/source-streams', { params: { path: { space } } })),
    forgetStream: (space: string, externalSourceId: string) =>
      unwrapAs<unknown>(
        api.DELETE('/v1/spaces/{space}/source-streams/{external_source_id}', {
          params: { path: { space, external_source_id: externalSourceId } },
        }),
      ),
  },

  search: {
    run: (space: string, query: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/search', { params: { path: { space }, query: query as never } })),
    ask: (space: string, body: Record<string, unknown>) =>
      unwrapAs<unknown>(api.POST('/v1/spaces/{space}/query', { params: { path: { space } }, body: body as never })),
  },

  /**
   * Change proposals. The console calls them "changes" everywhere a human can
   * see, because that is what they are: an edit waiting for somebody to say
   * yes. `proposal` stays in the code, where it matches the API and the tables.
   */
  changes: {
    list: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/proposals', { params: { path: { space }, query: query as never } })),
    get: (id: string) => unwrap(api.GET('/v1/proposals/{id}', { params: { path: { id } } })),
    lint: (id: string) => unwrap(api.GET('/v1/proposals/{id}/lint', { params: { path: { id } } })),
    propose: (space: string, body: Record<string, unknown>) =>
      unwrapAs<{ proposal_id: string }>(
        api.POST('/v1/spaces/{space}/proposals', { params: { path: { space } }, body: body as never }),
      ),
    approve: (id: string, body: Record<string, unknown> = {}) =>
      unwrapAs<unknown>(api.POST('/v1/proposals/{id}/approve', { params: { path: { id } }, body: body as never })),
    reject: (id: string, body: Record<string, unknown> = {}) =>
      unwrapAs<unknown>(api.POST('/v1/proposals/{id}/reject', { params: { path: { id } }, body: body as never })),
    requestChanges: (id: string, body: Record<string, unknown>) =>
      unwrapAs<unknown>(
        api.POST('/v1/proposals/{id}/request-changes', { params: { path: { id } }, body: body as never }),
      ),
    split: (id: string, body: Record<string, unknown>) =>
      unwrapAs<unknown>(api.POST('/v1/proposals/{id}/split', { params: { path: { id } }, body: body as never })),
  },

  ingest: {
    submit: (space: string, body: Record<string, unknown>) =>
      unwrapAs<{ ingest_id: string }>(
        api.POST('/v1/spaces/{space}/ingest', { params: { path: { space } }, body: body as never }),
      ),
    job: (id: string) => unwrap(api.GET('/v1/ingests/{id}', { params: { path: { id } } })),
  },

  charter: {
    get: (space: string) => unwrap(api.GET('/v1/spaces/{space}/charter', { params: { path: { space } } })),
    versions: (space: string) =>
      unwrap(api.GET('/v1/spaces/{space}/charter/versions', { params: { path: { space } } })),
    put: (space: string, body: Record<string, unknown>) =>
      unwrapAs<unknown>(api.PUT('/v1/spaces/{space}/charter', { params: { path: { space } }, body: body as never })),
    remove: (space: string) =>
      unwrapAs<unknown>(api.DELETE('/v1/spaces/{space}/charter', { params: { path: { space } } })),
  },

  lint: {
    space: (space: string) => unwrap(api.GET('/v1/spaces/{space}/lint', { params: { path: { space } } })),
  },

  webhooks: {
    list: (space: string) => unwrap(api.GET('/v1/spaces/{space}/webhooks', { params: { path: { space } } })),
    create: (space: string, body: Record<string, unknown>) =>
      unwrapAs<unknown>(api.POST('/v1/spaces/{space}/webhooks', { params: { path: { space } }, body: body as never })),
    deliveries: (space: string, id: string) =>
      unwrap(api.GET('/v1/spaces/{space}/webhooks/{id}/deliveries', { params: { path: { space, id } } })),
  },

  keys: {
    list: () => unwrap(api.GET('/v1/api-keys')),
    create: (body: Record<string, unknown>) =>
      unwrapAs<{ key: string }>(api.POST('/v1/api-keys', { body: body as never })),
    revoke: (id: string) => unwrapAs<unknown>(api.DELETE('/v1/api-keys/{id}', { params: { path: { id } } })),
  },

  identities: {
    list: () => unwrap(api.GET('/v1/identities')),
    grant: (provider: string, subject: string, body: Record<string, unknown>) =>
      unwrapAs<unknown>(
        api.PUT('/v1/identities/{provider}/{subject}', {
          params: { path: { provider, subject } },
          body: body as never,
        }),
      ),
    revoke: (provider: string, subject: string) =>
      unwrapAs<unknown>(api.DELETE('/v1/identities/{provider}/{subject}', { params: { path: { provider, subject } } })),
  },

  stats: {
    knowledge: (space: string) =>
      unwrap(api.GET('/v1/spaces/{space}/stats/knowledge', { params: { path: { space } } })),
    reviews: (space: string) => unwrap(api.GET('/v1/spaces/{space}/stats/reviews', { params: { path: { space } } })),
    ingests: (space: string) => unwrap(api.GET('/v1/spaces/{space}/stats/ingests', { params: { path: { space } } })),
    /**
     * Coverage takes a REQUIRED window — the server has no default for it,
     * because "how much is disputed" and "how long a review took" are only
     * meaningful over a stated period. The caller supplies both bounds so the
     * page can print the window beside the numbers rather than showing a
     * figure whose period nobody can name.
     */
    coverage: (space: string, window: { from: string; to: string; top?: number }) =>
      unwrap(api.GET('/v1/spaces/{space}/stats/coverage', { params: { path: { space }, query: window } })),
    http: (space: string) => unwrap(api.GET('/v1/spaces/{space}/stats/http', { params: { path: { space } } })),
    usage: (space: string) => unwrap(api.GET('/v1/spaces/{space}/stats/usage', { params: { path: { space } } })),
    llm: (space: string) => unwrap(api.GET('/v1/spaces/{space}/stats/llm', { params: { path: { space } } })),
    webhooks: (space: string) => unwrap(api.GET('/v1/spaces/{space}/stats/webhooks', { params: { path: { space } } })),
    mcp: () => unwrap(api.GET('/v1/stats/mcp')),
  },
} as const

/**
 * Query keys, spelled once.
 *
 * Every key starts with the space it belongs to, so switching wiki invalidates
 * a whole subtree by prefix rather than by remembering to list each entry.
 */
export const keys = {
  spaces: () => ['spaces'] as const,
  space: (space: string) => ['spaces', space] as const,
  concepts: (space: string, query?: unknown) => ['spaces', space, 'concepts', query ?? null] as const,
  concept: (space: string, slug: string) => ['spaces', space, 'concepts', slug] as const,
  conceptHistory: (space: string, slug: string) => ['spaces', space, 'concepts', slug, 'history'] as const,
  decisions: (space: string, query?: unknown) => ['spaces', space, 'decisions', query ?? null] as const,
  decision: (space: string, slug: string) => ['spaces', space, 'decisions', slug] as const,
  sources: (space: string, query?: unknown) => ['spaces', space, 'sources', query ?? null] as const,
  source: (space: string, id: string) => ['spaces', space, 'sources', id] as const,
  streams: (space: string) => ['spaces', space, 'source-streams'] as const,
  search: (space: string, query: unknown) => ['spaces', space, 'search', query] as const,
  changes: (space: string, query?: unknown) => ['spaces', space, 'changes', query ?? null] as const,
  change: (id: string) => ['changes', id] as const,
  changeLint: (id: string) => ['changes', id, 'lint'] as const,
  ingestJob: (id: string) => ['ingests', id] as const,
  charter: (space: string) => ['spaces', space, 'charter'] as const,
  charterVersions: (space: string) => ['spaces', space, 'charter', 'versions'] as const,
  lint: (space: string) => ['spaces', space, 'lint'] as const,
  webhooks: (space: string) => ['spaces', space, 'webhooks'] as const,
  webhookDeliveries: (space: string, id: string) => ['spaces', space, 'webhooks', id, 'deliveries'] as const,
  apiKeys: () => ['api-keys'] as const,
  identities: () => ['identities'] as const,
  stats: (space: string, kind: string) => ['spaces', space, 'stats', kind] as const,
  mcpStats: () => ['stats', 'mcp'] as const,
} as const
