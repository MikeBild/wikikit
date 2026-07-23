-- Cross-space federation — qualified references, never knowledge copies.
--
--   * Spaces stay the tenancy and review boundary; federation links
--     KNOWLEDGE across them: a relation may now point at a concept in
--     another space ('mikebild-platform:contentkit'-style qualified slugs at
--     the boundary), provided the target space is DECLARED in the source
--     space's settings.imports and the staging principal can see both
--     spaces.
--   * to_space_id is a nullable denormalized column (null = intra-space, the
--     overwhelmingly common row): to_concept_id is already a globally unique
--     uuid, so the row shape supports foreign targets as-is — a second graph
--     table would duplicate the entire staged/active/removed lifecycle
--     machinery for no gain. wk_apply_proposal / wk_reject_proposal flip by
--     proposal_id and need NO change.
--   * Citations stay strictly intra-space (createProposal's tenant check is
--     untouched): federation links knowledge, never provenance.
--   * No backfill: every existing row is intra-space and NULL is that
--     encoding.
alter table public.wk_relations
  add column if not exists to_space_id uuid references public.wk_spaces(id) on delete cascade;

create index if not exists wk_relations_to_space_idx
  on public.wk_relations (to_space_id)
  where to_space_id is not null;
