-- Time-leading, space-scoped indexes for the product analytics API. The API
-- aggregates WikiKit's own tables at read time; no cross-product database
-- access and no consumer-specific reporting tables are introduced.
create index if not exists wk_ingest_jobs_space_created_idx
  on public.wk_ingest_jobs (space_id, created_at);
create index if not exists wk_concepts_space_created_idx
  on public.wk_concepts (space_id, created_at);
create index if not exists wk_concept_revisions_space_created_idx
  on public.wk_concept_revisions (space_id, created_at);
create index if not exists wk_claims_space_created_idx
  on public.wk_claims (space_id, created_at);
create index if not exists wk_citations_space_created_idx
  on public.wk_citations (space_id, created_at);
create index if not exists wk_decisions_space_created_idx
  on public.wk_decisions (space_id, created_at);
create index if not exists wk_change_proposals_space_created_idx
  on public.wk_change_proposals (space_id, created_at);
create index if not exists wk_change_proposals_space_reviewed_idx
  on public.wk_change_proposals (space_id, reviewed_at)
  where reviewed_at is not null;
create index if not exists wk_outbox_events_space_created_idx
  on public.wk_outbox_events (space_id, created_at);
create index if not exists wk_webhook_endpoints_space_idx
  on public.wk_webhook_endpoints (space_id, id);
create index if not exists wk_webhook_deliveries_endpoint_created_idx
  on public.wk_webhook_deliveries (endpoint_id, created_at);
