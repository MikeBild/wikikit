import { api, postRaw, unwrap, unwrapAs } from './client'

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
    neighbors: (space: string, slug: string) =>
      unwrap(api.GET('/v1/spaces/{space}/concepts/{slug}/neighbors', { params: { path: { space, slug } } })),
    deleted: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/deleted-concepts', { params: { path: { space }, query: query as never } })),
    remove: (space: string, slug: string) =>
      unwrapAs<{ proposal_id: string }>(
        api.DELETE('/v1/spaces/{space}/concepts/{slug}', { params: { path: { space, slug } } }),
      ),
    restore: (space: string, slug: string) =>
      unwrapAs<{ proposal_id: string }>(
        api.POST('/v1/spaces/{space}/concepts/{slug}/restore', { params: { path: { space, slug } } }),
      ),
  },

  decisionLog: {
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
    references: (space: string, id: string, query?: Record<string, unknown>) =>
      unwrap(
        api.GET('/v1/spaces/{space}/sources/{id}/references', {
          params: { path: { space, id }, query: query as never },
        }),
      ),
    resynthesize: (space: string, id: string) =>
      unwrap(
        api.POST('/v1/spaces/{space}/sources/{id}/resynthesize', {
          params: { path: { space, id } },
        }),
      ),
    // Takes a query for one reason: `zSourceStreamListQuery` accepts a `limit`
    // and defaults to 50 without one, and a caller that cannot name the limit
    // cannot know which ceiling it is under.
    streams: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/source-streams', { params: { path: { space }, query: query as never } })),
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

  proposals: {
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
    /**
     * A FILE, and the only call in this facade that does not go through
     * openapi-fetch — see `postRaw` for why the typed client cannot carry it.
     *
     * One file, one call, one job, on purpose. The inbox drops N files as N
     * independent requests rather than one bundle: each source keeps its own
     * content hash, its own change proposal and its own review, and a single
     * proposal holding forty documents is a proposal nobody can decide.
     */
    document: (space: string, filename: string, file: Blob) =>
      postRaw<{ ingest_id: string; status: string }>(
        '/v1/spaces/{space}/ingest/document'.replace('{space}', encodeURIComponent(space)),
        { filename, capture: 'true' },
        file,
      ),
    /**
     * This wiki's ingest jobs, newest first — the inbox itself.
     *
     * `knowledge:read` with `knowledge:propose` as an alternative on the server:
     * a contributor key can already poll any single job it started, so refusing
     * it the list of them would be a gap rather than a boundary.
     */
    list: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/ingests', { params: { path: { space }, query: query as never } })),
    job: (id: string) => unwrap(api.GET('/v1/ingests/{id}', { params: { path: { id } } })),
    triage: (id: string) => unwrap(api.GET('/v1/ingests/{id}/triage', { params: { path: { id } } })),
    suggestTriage: (id: string) => unwrap(api.POST('/v1/ingests/{id}/triage', { params: { path: { id } } })),
    resolveTriage: (id: string, body: Record<string, unknown>) =>
      unwrap(api.POST('/v1/ingests/{id}/triage/resolve', { params: { path: { id } }, body: body as never })),
  },

  attention: {
    list: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/attention', { params: { path: { space }, query: query as never } })),
    setState: (space: string, key: string, body: Record<string, unknown>) =>
      unwrap(
        api.PUT('/v1/spaces/{space}/attention/{key}', {
          params: { path: { space, key } },
          body: body as never,
        }),
      ),
  },

  /**
   * Persisted answers, briefings and health reports — the fourth place.
   *
   * `get` and `promote` are global-by-id and NOT space-scoped in their path:
   * the row itself carries the space, and the transport enforces the key/space
   * match. That is the same §4 convention `/v1/ingests/{id}` follows, which is
   * why the two read alike here.
   */
  outputs: {
    list: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/outputs', { params: { path: { space }, query: query as never } })),
    get: (id: string) => unwrap(api.GET('/v1/outputs/{id}', { params: { path: { id } } })),
    /**
     * Answers 202 with the ingest job the promotion opened — never a proposal
     * id, because promotion runs the whole pipeline (content-hash dedup,
     * grounding guard, contradiction check) and only that job knows whether a
     * change came out of it. Re-promoting returns the FIRST job's id.
     */
    promote: (id: string) =>
      unwrapAs<{ ingest_id: string }>(api.POST('/v1/outputs/{id}/promote', { params: { path: { id } } })),
  },

  /**
   * The cross-wiki overview: per visible wiki the human decisions still open,
   * their oldest age and the page count, with totals summed server-side.
   * Space-less on purpose — it is the
   * one read about ALL the wikis, and a space-scoped key gets one row.
   */
  overview: {
    get: () => unwrap(api.GET('/v1/stats/overview')),
  },

  /**
   * One composed read of how a wiki is doing: the lint report whole, the
   * coverage block whole, and the two live queues neither of them measures.
   * No LLM, no verdict — the thresholds that would produce one are policy.
   */
  health: {
    space: (space: string, query?: Record<string, unknown>) =>
      unwrap(api.GET('/v1/spaces/{space}/health', { params: { path: { space }, query: query as never } })),
  },

  /** The in-process briefing/health worker's timetable. Admin, both ways. */
  schedules: {
    get: (space: string) => unwrap(api.GET('/v1/spaces/{space}/schedules', { params: { path: { space } } })),
    /** A REPLACE, not a patch: the body is the complete set, and a kind left out is switched off. */
    put: (space: string, body: Record<string, unknown>) =>
      unwrapAs<unknown>(api.PUT('/v1/spaces/{space}/schedules', { params: { path: { space } }, body: body as never })),
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
    // Takes a query for the same reason `sources.streams` does: the endpoint
    // answers the 50 newest attempts to a request that names no `limit`, and a
    // caller that cannot name one cannot know which ceiling it is under.
    deliveries: (space: string, id: string, query?: Record<string, unknown>) =>
      unwrap(
        api.GET('/v1/spaces/{space}/webhooks/{id}/deliveries', {
          params: { path: { space, id }, query: query as never },
        }),
      ),
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
    llmAll: () => unwrap(api.GET('/v1/stats/llm')),
    webhooks: (space: string) => unwrap(api.GET('/v1/spaces/{space}/stats/webhooks', { params: { path: { space } } })),
    mcp: () => unwrap(api.GET('/v1/stats/mcp')),
  },

  /**
   * What this INSTALLATION is set up to do, as opposed to what any one wiki
   * holds. Not space-scoped and deliberately not under `stats`: it is not a
   * measurement, it is the configuration that decides what gets measured.
   */
  installation: {
    knowledgeConfig: () => unwrap(api.GET('/v1/installation/knowledge-config')),
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
  conceptNeighbors: (space: string, slug: string) => ['spaces', space, 'concepts', slug, 'neighbors'] as const,
  deletedConcepts: (space: string, query?: unknown) => ['spaces', space, 'deleted-concepts', query ?? null] as const,
  decisionLog: (space: string, query?: unknown) => ['spaces', space, 'decision-log', query ?? null] as const,
  decisionLogEntry: (space: string, slug: string) => ['spaces', space, 'decision-log', slug] as const,
  sources: (space: string, query?: unknown) => ['spaces', space, 'sources', query ?? null] as const,
  source: (space: string, id: string) => ['spaces', space, 'sources', id] as const,
  sourceReferences: (space: string, id: string) => ['spaces', space, 'sources', id, 'references'] as const,
  // The query slot is part of the key, exactly as it is for sources and
  // concepts: two reads of this list under different limits are two different
  // answers, and a mutation must invalidate the one it changed by naming it.
  streams: (space: string, query?: unknown) => ['spaces', space, 'source-streams', query ?? null] as const,
  search: (space: string, query: unknown) => ['spaces', space, 'search', query] as const,
  proposals: (space: string, query?: unknown) => ['spaces', space, 'proposals', query ?? null] as const,
  proposal: (id: string) => ['proposals', id] as const,
  proposalLint: (id: string) => ['proposals', id, 'lint'] as const,
  attention: (space: string, query?: unknown) => ['spaces', space, 'attention', query ?? null] as const,
  triage: (id: string) => ['ingests', id, 'triage'] as const,
  ingestJob: (id: string) => ['ingests', id] as const,
  // The query slot is part of the key for the same reason it is on sources: the
  // inbox reads one status filter at a time, and a mutation must invalidate the
  // window it changed by naming it.
  ingestJobs: (space: string, query?: unknown) => ['spaces', space, 'ingests', query ?? null] as const,
  outputs: (space: string, query?: unknown) => ['spaces', space, 'outputs', query ?? null] as const,
  // No space in the key, because the path has none: an output is addressed by
  // id and answers its own space_id.
  output: (id: string) => ['outputs', id] as const,
  health: (space: string, query?: unknown) => ['spaces', space, 'health', query ?? null] as const,
  schedules: (space: string) => ['spaces', space, 'schedules'] as const,
  charter: (space: string) => ['spaces', space, 'charter'] as const,
  charterVersions: (space: string) => ['spaces', space, 'charter', 'versions'] as const,
  lint: (space: string) => ['spaces', space, 'lint'] as const,
  webhooks: (space: string) => ['spaces', space, 'webhooks'] as const,
  webhookDeliveries: (space: string, id: string) => ['spaces', space, 'webhooks', id, 'deliveries'] as const,
  apiKeys: () => ['api-keys'] as const,
  identities: () => ['identities'] as const,
  stats: (space: string, kind: string) => ['spaces', space, 'stats', kind] as const,
  mcpStats: () => ['stats', 'mcp'] as const,
  llmAllStats: () => ['stats', 'llm'] as const,
  // No space in it, like mcpStats: switching wiki must not invalidate the one
  // answer that is about all of them.
  overview: () => ['stats', 'overview'] as const,
  // No space in it, and that is the point: switching wiki must not invalidate
  // an answer that was never about a wiki.
  knowledgeConfig: () => ['installation', 'knowledge-config'] as const,
} as const
