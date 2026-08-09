-- Review-gated concept deletion and restoration. A deleted concept is an
-- identity with no current revision; its evidence and revision history remain
-- immutable and restorable.
alter table public.wk_concepts
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_revision_id uuid references public.wk_concept_revisions(id);

create table if not exists public.wk_concept_lifecycle_changes (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  concept_id uuid not null references public.wk_concepts(id) on delete cascade,
  proposal_id uuid not null references public.wk_change_proposals(id) on delete cascade,
  action text not null check (action in ('delete', 'restore')),
  revision_id uuid not null references public.wk_concept_revisions(id),
  created_at timestamptz not null default now(),
  unique (proposal_id, concept_id)
);
create index if not exists wk_concept_lifecycle_changes_concept_idx
  on public.wk_concept_lifecycle_changes (concept_id, created_at desc);

-- The existing review function flips proposal.status as its final operation.
-- This trigger keeps the lifecycle action in that same transaction: a stale
-- target aborts the whole approval, exactly like an ordinary stale revision.
create or replace function public.wk_apply_concept_lifecycle_change()
returns trigger language plpgsql set search_path = public as $$
declare
  change_row public.wk_concept_lifecycle_changes%rowtype;
  concept_row public.wk_concepts%rowtype;
  space_slug text;
begin
  if old.status <> 'pending' or new.status <> 'approved' then return new; end if;
  select slug into space_slug from public.wk_spaces where id = new.space_id;
  for change_row in select * from public.wk_concept_lifecycle_changes where proposal_id = new.id order by created_at, id loop
    select * into concept_row from public.wk_concepts where id = change_row.concept_id for update;
    if change_row.action = 'delete' then
      if concept_row.current_revision_id is distinct from change_row.revision_id then raise exception 'stale_base'; end if;
      update public.wk_concept_revisions set status = 'superseded' where id = change_row.revision_id and status = 'current';
      update public.wk_concepts set current_revision_id = null, deleted_at = now(), deleted_revision_id = change_row.revision_id, updated_at = now() where id = change_row.concept_id;
      insert into public.wk_outbox_events (space_id, event_type, payload) values
        (new.space_id, 'wikikit.concept.deleted', jsonb_build_object('space', space_slug, 'slug', concept_row.slug, 'revision_id', change_row.revision_id, 'proposal_id', new.id));
    else
      if concept_row.current_revision_id is not null or concept_row.deleted_revision_id is distinct from change_row.revision_id then raise exception 'stale_base'; end if;
      update public.wk_concept_revisions set status = 'current' where id = change_row.revision_id and status = 'superseded';
      update public.wk_concepts set current_revision_id = change_row.revision_id, deleted_at = null, deleted_revision_id = null, updated_at = now() where id = change_row.concept_id;
      insert into public.wk_outbox_events (space_id, event_type, payload) values
        (new.space_id, 'wikikit.concept.restored', jsonb_build_object('space', space_slug, 'slug', concept_row.slug, 'revision_id', change_row.revision_id, 'proposal_id', new.id));
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists wk_apply_concept_lifecycle_change on public.wk_change_proposals;
create trigger wk_apply_concept_lifecycle_change after update of status on public.wk_change_proposals
  for each row execute function public.wk_apply_concept_lifecycle_change();

-- Claims and revisions remain archived. The request-layer readable-page check
-- prevents claims of deleted pages from being returned by search.
