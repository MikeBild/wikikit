-- WikiKit schema baseline. Embedded in the single binary and applied by the
-- self-migrator under an advisory lock — never by deployment scripts. Keep
-- changes additive and create a new migration after release.
--
-- Central pattern (analog of ContentKit's ck_activate_release): proposal
-- content is REAL ROWS in the target tables with status='proposed' +
-- proposal_id — never a JSON diff blob. Approval is a single atomic status
-- flip inside wk_apply_proposal; rejection keeps every row for audit.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- wk_spaces — workspace scoping. Multi-space from day one; every space-scoped
-- query downstream filters by space_id. `epoch` is bumped on every approved
-- proposal and drives ETag caching on list endpoints.
create table if not exists public.wk_spaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null,
  settings jsonb not null default '{}'::jsonb,
  epoch bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- wk_sources — original sources archived verbatim. (space_id, content_hash)
-- is the idempotency anchor: re-ingesting identical content is a 409, never a
-- duplicate row.
create table if not exists public.wk_sources (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  content_hash text not null,
  kind text not null check (kind in ('markdown', 'text', 'url', 'import')),
  url text,
  title text,
  raw_content text not null,
  markdown text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (space_id, content_hash)
);
create index if not exists wk_sources_space_created_idx
  on public.wk_sources (space_id, created_at desc);

-- ---------------------------------------------------------------------------
-- wk_concepts — wiki page identity. current_revision_id stays NULL until the
-- first proposal touching the concept is approved, so concepts with only
-- proposed revisions are invisible to readers by construction.
create table if not exists public.wk_concepts (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,126}$'),
  title text not null,
  current_revision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, slug)
);

-- ---------------------------------------------------------------------------
-- wk_concept_revisions — immutable page versions. Rows are never UPDATEd
-- except for the status flip inside wk_apply_proposal / wk_reject_proposal;
-- content columns are immutable, which is why the search_vector trigger
-- (migration 0001) fires on INSERT only. base_revision_id records what the
-- revision was synthesized against — the stale-base detection anchor.
create table if not exists public.wk_concept_revisions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  concept_id uuid not null references public.wk_concepts(id) on delete cascade,
  rev integer not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'current', 'superseded', 'rejected')),
  title text not null,
  summary text not null default '',
  markdown text not null,
  base_revision_id uuid references public.wk_concept_revisions(id),
  agent_meta jsonb not null default '{}'::jsonb,
  proposal_id uuid,
  search_vector tsvector,
  created_at timestamptz not null default now(),
  unique (concept_id, rev)
);

alter table public.wk_concepts
  drop constraint if exists wk_concepts_current_revision_fk;
alter table public.wk_concepts
  add constraint wk_concepts_current_revision_fk
  foreign key (current_revision_id) references public.wk_concept_revisions(id);

create index if not exists wk_concept_revisions_search_idx
  on public.wk_concept_revisions using gin (search_vector);
create index if not exists wk_concept_revisions_proposal_idx
  on public.wk_concept_revisions (proposal_id);

-- ---------------------------------------------------------------------------
-- wk_claims — verifiable statements. The (space_id, subject, predicate) index
-- is the exact-frame contradiction matcher's backbone: same frame, different
-- object = dispute.
create table if not exists public.wk_claims (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  concept_id uuid not null references public.wk_concepts(id) on delete cascade,
  subject text not null,
  predicate text not null,
  object text not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'draft', 'verified', 'disputed', 'deprecated')),
  confidence real not null default 0.5 check (confidence >= 0 and confidence <= 1),
  valid_from timestamptz,
  valid_until timestamptz,
  proposal_id uuid,
  agent_meta jsonb not null default '{}'::jsonb,
  search_vector tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wk_claims_frame_idx on public.wk_claims (space_id, subject, predicate);
create index if not exists wk_claims_concept_idx on public.wk_claims (concept_id, status);
create index if not exists wk_claims_search_idx on public.wk_claims using gin (search_vector);

-- ---------------------------------------------------------------------------
-- wk_citations — provenance per claim. ON DELETE RESTRICT on source_id: a
-- source that backs a claim can never silently vanish.
create table if not exists public.wk_citations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  claim_id uuid not null references public.wk_claims(id) on delete cascade,
  source_id uuid not null references public.wk_sources(id) on delete restrict,
  quote text not null,
  locator text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists wk_citations_claim_idx on public.wk_citations (claim_id);

-- ---------------------------------------------------------------------------
-- wk_relations — typed concept links. The unique constraint makes
-- 'contradicts' relation upserts inside wk_apply_proposal idempotent.
create table if not exists public.wk_relations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  from_concept_id uuid not null references public.wk_concepts(id) on delete cascade,
  to_concept_id uuid not null references public.wk_concepts(id) on delete cascade,
  kind text not null check (kind in ('related', 'part_of', 'depends_on', 'contradicts', 'supersedes')),
  status text not null default 'proposed' check (status in ('proposed', 'active', 'removed')),
  proposal_id uuid,
  created_at timestamptz not null default now(),
  unique (space_id, from_concept_id, to_concept_id, kind)
);

-- ---------------------------------------------------------------------------
-- wk_decisions — decision records (context, rationale, alternatives).
create table if not exists public.wk_decisions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,126}$'),
  title text not null,
  context text not null,
  decision text not null,
  rationale text not null default '',
  alternatives jsonb not null default '[]'::jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'active', 'superseded')),
  proposal_id uuid,
  agent_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (space_id, slug)
);

-- ---------------------------------------------------------------------------
-- wk_change_proposals — the review gate. The partial unique index dedups
-- pending proposals per (space, input_hash): retrying an identical ingest
-- converges on the same pending proposal instead of stacking duplicates.
create table if not exists public.wk_change_proposals (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'failed')),
  title text not null,
  summary text not null default '',
  input_hash text not null,
  source_ids uuid[] not null default '{}',
  agent_meta jsonb not null default '{}'::jsonb,
  reviewer text,
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists wk_change_proposals_pending_dedup
  on public.wk_change_proposals (space_id, input_hash) where status = 'pending';

-- Deferred proposal FKs (circular with the staging tables above). ON DELETE
-- SET NULL: deleting a proposal never cascades into knowledge rows.
alter table public.wk_concept_revisions
  drop constraint if exists wk_concept_revisions_proposal_fk;
alter table public.wk_concept_revisions
  add constraint wk_concept_revisions_proposal_fk
  foreign key (proposal_id) references public.wk_change_proposals(id) on delete set null;

alter table public.wk_claims
  drop constraint if exists wk_claims_proposal_fk;
alter table public.wk_claims
  add constraint wk_claims_proposal_fk
  foreign key (proposal_id) references public.wk_change_proposals(id) on delete set null;

alter table public.wk_relations
  drop constraint if exists wk_relations_proposal_fk;
alter table public.wk_relations
  add constraint wk_relations_proposal_fk
  foreign key (proposal_id) references public.wk_change_proposals(id) on delete set null;

alter table public.wk_decisions
  drop constraint if exists wk_decisions_proposal_fk;
alter table public.wk_decisions
  add constraint wk_decisions_proposal_fk
  foreign key (proposal_id) references public.wk_change_proposals(id) on delete set null;

-- ---------------------------------------------------------------------------
-- wk_api_keys — scoped keys. key_hash = hex HMAC-SHA256(pepper, full key
-- string); plaintext is returned exactly once at creation and never stored.
create table if not exists public.wk_api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null unique,
  scopes text[] not null,
  space_id uuid references public.wk_spaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Webhooks — transactional outbox. Events are inserted in the SAME
-- transaction as the state change they describe (db.emitEvent / the SQL
-- functions below); the delivery worker picks up dispatched_at IS NULL.
create table if not exists public.wk_outbox_events (
  id bigserial primary key,
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz
);
create index if not exists wk_outbox_pending_idx
  on public.wk_outbox_events (id) where dispatched_at is null;

create table if not exists public.wk_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  url text not null,
  secret text not null,
  events text[] not null default '{}',
  active boolean not null default true,
  failure_count integer not null default 0,
  disabled_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.wk_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.wk_webhook_endpoints(id) on delete cascade,
  event_id bigint not null references public.wk_outbox_events(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'delivering', 'delivered', 'failed', 'dead')),
  attempt integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  response_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wk_webhook_deliveries_due_idx
  on public.wk_webhook_deliveries (next_attempt_at) where status in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- wk_ingest_jobs — async ingest status (202 + Location pattern).
create table if not exists public.wk_ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  input jsonb not null,
  source_id uuid references public.wk_sources(id),
  proposal_id uuid references public.wk_change_proposals(id),
  error jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists wk_ingest_jobs_queue_idx
  on public.wk_ingest_jobs (created_at) where status = 'queued';

-- ---------------------------------------------------------------------------
-- wk_agent_runs — LLM audit ledger, written for EVERY LLM call. The audit
-- contract downstream systems (SubKit governance) consume.
create table if not exists public.wk_agent_runs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  kind text not null check (kind in ('classify', 'synthesize', 'answer', 'adjudicate')),
  model text not null,
  prompt_version text not null,
  input_hash text not null,
  usage jsonb not null default '{}'::jsonb,
  duration_ms integer not null default 0,
  ingest_job_id uuid references public.wk_ingest_jobs(id) on delete set null,
  proposal_id uuid references public.wk_change_proposals(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists wk_agent_runs_space_idx
  on public.wk_agent_runs (space_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance: a single BEFORE UPDATE trigger instead of relying
-- on every writer to remember `updated_at = now()`. Applied to every table
-- that carries the column.
create or replace function public.wk_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists wk_spaces_touch_updated_at on public.wk_spaces;
create trigger wk_spaces_touch_updated_at
  before update on public.wk_spaces
  for each row execute function public.wk_touch_updated_at();

drop trigger if exists wk_concepts_touch_updated_at on public.wk_concepts;
create trigger wk_concepts_touch_updated_at
  before update on public.wk_concepts
  for each row execute function public.wk_touch_updated_at();

drop trigger if exists wk_claims_touch_updated_at on public.wk_claims;
create trigger wk_claims_touch_updated_at
  before update on public.wk_claims
  for each row execute function public.wk_touch_updated_at();

drop trigger if exists wk_webhook_deliveries_touch_updated_at on public.wk_webhook_deliveries;
create trigger wk_webhook_deliveries_touch_updated_at
  before update on public.wk_webhook_deliveries
  for each row execute function public.wk_touch_updated_at();

-- ---------------------------------------------------------------------------
-- wk_apply_proposal — atomic approve; the ONLY write path that promotes
-- proposed content. Analog of ck_activate_release.
--
-- Locking order (deadlock discipline): proposal row first (serializes reviews
-- of the SAME proposal → second caller sees 'approved' → proposal_not_pending),
-- then the affected concept rows in id order (serializes concurrent approvals
-- of DIFFERENT proposals touching the SAME concept → the loser re-reads
-- current_revision_id after the winner commits and fails the stale-base check).
--
-- Errors are raised with the machine code as the exact message
-- ('proposal_not_found' | 'proposal_not_pending' | 'stale_base') so the caller
-- maps err.message straight onto the §8 error envelope.
create or replace function public.wk_apply_proposal(p_proposal_id uuid, p_reviewer text, p_note text default null)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  proposal public.wk_change_proposals%rowtype;
  space_slug text;
  concept_slugs text[] := '{}';
  claims_verified integer := 0;
  claims_disputed integer := 0;
begin
  select * into proposal from wk_change_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal_not_found';
  end if;
  if proposal.status <> 'pending' then
    raise exception 'proposal_not_pending';
  end if;

  select slug into space_slug from wk_spaces where id = proposal.space_id;

  -- Lock every affected concept row, in id order so two proposals sharing a
  -- concept subset can never deadlock.
  perform 1
  from wk_concepts c
  where c.id in (
    select r.concept_id from wk_concept_revisions r where r.proposal_id = p_proposal_id
  )
  order by c.id
  for update;

  -- Stale-base check: every proposed revision must have been synthesized
  -- against what is STILL the concept's current revision (NULL = new concept,
  -- matched via IS DISTINCT FROM). Anything else means the base moved under
  -- the proposal → the reviewer approved a diff that no longer applies.
  if exists (
    select 1
    from wk_concept_revisions r
    join wk_concepts c on c.id = r.concept_id
    where r.proposal_id = p_proposal_id
      and r.status = 'proposed'
      and c.current_revision_id is distinct from r.base_revision_id
  ) then
    raise exception 'stale_base';
  end if;

  -- Flip 1: previous current revisions of the touched concepts → superseded.
  update wk_concept_revisions old
  set status = 'superseded'
  from wk_concept_revisions fresh
  join wk_concepts c on c.id = fresh.concept_id
  where fresh.proposal_id = p_proposal_id
    and fresh.status = 'proposed'
    and old.id = c.current_revision_id;

  -- Flip 2: proposed revisions → current.
  update wk_concept_revisions
  set status = 'current'
  where proposal_id = p_proposal_id and status = 'proposed';

  -- Flip 3: repoint the concept (and mirror the revision title so list
  -- endpoints never show a stale title).
  update wk_concepts c
  set current_revision_id = fresh.id,
      title = fresh.title,
      updated_at = now()
  from wk_concept_revisions fresh
  where fresh.proposal_id = p_proposal_id
    and fresh.status = 'current'
    and c.id = fresh.concept_id;

  -- Flip 4: proposed claims → verified.
  update wk_claims
  set status = 'verified'
  where proposal_id = p_proposal_id and status = 'proposed';
  get diagnostics claims_verified = row_count;

  -- Flip 5: exact-frame contradictions — a freshly verified claim colliding
  -- with a pre-existing visible claim on the same (space, subject, predicate)
  -- but a different object disputes BOTH sides. The status filters are stable
  -- under the flip itself ({verified,disputed} on either side), so the pair
  -- set is identical when recomputed for the relation insert below.
  with pairs as (
    select fresh.id as fresh_id, old.id as old_id
    from wk_claims fresh
    join wk_claims old
      on old.space_id = fresh.space_id
     and old.subject = fresh.subject
     and old.predicate = fresh.predicate
     and old.object <> fresh.object
    where fresh.proposal_id = p_proposal_id
      and fresh.status in ('verified', 'disputed')
      and old.proposal_id is distinct from p_proposal_id
      and old.status in ('verified', 'disputed')
  )
  update wk_claims
  set status = 'disputed'
  where status <> 'disputed'
    and id in (select fresh_id from pairs union select old_id from pairs);
  get diagnostics claims_disputed = row_count;

  -- Flip 5b: ensure a 'contradicts' relation between the concepts carrying a
  -- disputed pair. Upsert via the (space, from, to, kind) unique constraint.
  insert into wk_relations (space_id, from_concept_id, to_concept_id, kind, status, proposal_id)
  select distinct fresh.space_id, fresh.concept_id, old.concept_id, 'contradicts', 'active', p_proposal_id
  from wk_claims fresh
  join wk_claims old
    on old.space_id = fresh.space_id
   and old.subject = fresh.subject
   and old.predicate = fresh.predicate
   and old.object <> fresh.object
  where fresh.proposal_id = p_proposal_id
    and fresh.status = 'disputed'
    and old.proposal_id is distinct from p_proposal_id
    and old.status = 'disputed'
    and fresh.concept_id <> old.concept_id
  on conflict (space_id, from_concept_id, to_concept_id, kind)
    do update set status = 'active';

  -- Flip 6: relations and decisions staged by this proposal → active.
  update wk_relations
  set status = 'active'
  where proposal_id = p_proposal_id and status = 'proposed';

  update wk_decisions
  set status = 'active'
  where proposal_id = p_proposal_id and status = 'proposed';

  -- Flip 7: the proposal itself, plus the space epoch (ETag driver).
  update wk_change_proposals
  set status = 'approved', reviewer = p_reviewer, review_note = p_note, reviewed_at = now()
  where id = p_proposal_id;

  update wk_spaces
  set epoch = epoch + 1, updated_at = now()
  where id = proposal.space_id;

  select coalesce(array_agg(distinct c.slug), '{}')
  into concept_slugs
  from wk_concept_revisions r
  join wk_concepts c on c.id = r.concept_id
  where r.proposal_id = p_proposal_id;

  -- Outbox events in the SAME transaction — the transactional-outbox
  -- guarantee webhooks depend on.
  insert into wk_outbox_events (space_id, event_type, payload)
  values (
    proposal.space_id,
    'wikikit.proposal.approved',
    jsonb_build_object(
      'proposal_id', p_proposal_id,
      'space', space_slug,
      'reviewer', p_reviewer,
      'note', p_note,
      'concepts', to_jsonb(concept_slugs)
    )
  );

  insert into wk_outbox_events (space_id, event_type, payload)
  select proposal.space_id,
         'wikikit.concept.updated',
         jsonb_build_object('space', space_slug, 'slug', c.slug, 'rev', r.rev, 'proposal_id', p_proposal_id)
  from wk_concept_revisions r
  join wk_concepts c on c.id = r.concept_id
  where r.proposal_id = p_proposal_id and r.status = 'current';

  return jsonb_build_object(
    'proposal_id', p_proposal_id,
    'status', 'approved',
    'concepts', to_jsonb(concept_slugs),
    'claims_verified', claims_verified,
    'claims_disputed', claims_disputed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- wk_reject_proposal — atomic reject. Proposed rows KEEP their rows (audit
-- trail) but become invisible: revisions → 'rejected', relations → 'removed',
-- claims and decisions stay 'proposed' pinned to the rejected proposal
-- (readers only ever see verified/disputed/deprecated claims and active
-- relations/decisions, so nothing leaks).
create or replace function public.wk_reject_proposal(p_proposal_id uuid, p_reviewer text, p_note text default null)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  proposal public.wk_change_proposals%rowtype;
  space_slug text;
begin
  select * into proposal from wk_change_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal_not_found';
  end if;
  if proposal.status <> 'pending' then
    raise exception 'proposal_not_pending';
  end if;

  select slug into space_slug from wk_spaces where id = proposal.space_id;

  update wk_concept_revisions
  set status = 'rejected'
  where proposal_id = p_proposal_id and status = 'proposed';

  update wk_relations
  set status = 'removed'
  where proposal_id = p_proposal_id and status = 'proposed';

  update wk_change_proposals
  set status = 'rejected', reviewer = p_reviewer, review_note = p_note, reviewed_at = now()
  where id = p_proposal_id;

  insert into wk_outbox_events (space_id, event_type, payload)
  values (
    proposal.space_id,
    'wikikit.proposal.rejected',
    jsonb_build_object(
      'proposal_id', p_proposal_id,
      'space', space_slug,
      'reviewer', p_reviewer,
      'note', p_note
    )
  );

  return jsonb_build_object('proposal_id', p_proposal_id, 'status', 'rejected');
end;
$$;
