-- wk_charter_revisions — the per-space Charter as a versioned document.
--
-- The Charter is the human-owned "discipline layer" (llm-wiki CLAUDE.md
-- equivalent): free markdown that steers synthesis + classification and is
-- rendered as a virtual document (authored text + a KB-derived overview).
--
-- WHY a revision table and not a wk_spaces.settings key: every write is
-- auto-versioned like a document — there is a `latest` (the single 'current'
-- row per space) plus full history. The model mirrors wk_concept_revisions:
-- rows are immutable except the status flip; base_revision_id records what the
-- write was based on.
--
-- WHY no review gate on THESE rows: the authored charter is human-owned
-- configuration, not synthesized knowledge — an admin writes it directly. (The
-- bidirectional overview→knowledge edit path is what routes through
-- wk_change_proposals; that touches concepts/claims, never this table.)
create table if not exists public.wk_charter_revisions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  rev integer not null,
  status text not null default 'current'
    check (status in ('current', 'superseded')),
  markdown text not null,
  base_revision_id uuid references public.wk_charter_revisions(id),
  agent_meta jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  unique (space_id, rev)
);

-- Exactly ONE 'current' row per space = the `latest` pointer. A write flips the
-- old current → superseded and inserts rev+1 as current, atomically; deleting
-- the charter flips current → superseded with no replacement (history stays).
create unique index if not exists wk_charter_revisions_current_idx
  on public.wk_charter_revisions (space_id) where status = 'current';
