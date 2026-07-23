-- Richer claim semantics — the ADDITIVE half (the apply-function rewrite is
-- 0022, kept separate so the risky function swap reviews/reverts on its own).
--
--   * The exact-frame rule (same subject+predicate, different object) is
--     robust but too coarse: firmware versions, architecture states and
--     product facts are often TEMPORALLY different, not contradictory, and
--     often scoped to a context (region, product version, tenant).
--   * context: a nullable text partition of the frame — the frame key
--     becomes (subject, predicate, coalesce(context,'')). Text, not jsonb:
--     equality must be deterministic and diffs human-readable ('region:eu').
--     NULL = universal.
--   * object_normalized / object_value_num / object_unit: the canonical
--     comparison form, computed SERVER-SIDE at staging from the space's
--     predicate registry (settings.predicate_defs — typed predicates with
--     explicit unit-conversion factors; no built-in unit ontology). All
--     nullable: comparison sites use coalesce(object_normalized, object), so
--     pre-0021 rows behave exactly as before with NO backfill.
--   * supersedes_claim_id: staged, reviewer-visible succession — approval
--     deprecates the referenced claim deterministically (0022 flip 5c),
--     never as an implicit LLM side effect.
alter table public.wk_claims
  add column if not exists context text
    check (context is null or length(context) between 1 and 200),
  add column if not exists object_normalized text,
  add column if not exists object_value_num numeric,
  add column if not exists object_unit text,
  add column if not exists supersedes_claim_id uuid references public.wk_claims(id);

create index if not exists wk_claims_frame_ctx_idx
  on public.wk_claims (space_id, subject, predicate, coalesce(context, ''));

-- wk_functional_predicates v2: settings.predicate_defs (the typed registry,
-- [{name, type, functional, unit?, enum_values?}]) is consulted FIRST; the
-- legacy settings.functional_predicates array remains as fallback and both
-- are unioned — declaring a registry must never silently drop an existing
-- functional declaration. Same signature (create or replace).
create or replace function public.wk_functional_predicates(p_space_id uuid)
returns text[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(distinct name), '{}'::text[])
  from (
    select def->>'name' as name
    from wk_spaces s
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(s.settings->'predicate_defs') = 'array'
          then s.settings->'predicate_defs'
        else '[]'::jsonb
      end
    ) as def
    where s.id = p_space_id
      and (def->>'functional')::boolean is true
      and def->>'name' is not null
    union all
    select item.value
    from wk_spaces s
    cross join lateral jsonb_array_elements_text(
      case
        when jsonb_typeof(s.settings->'functional_predicates') = 'array'
          then s.settings->'functional_predicates'
        else '[]'::jsonb
      end
    ) as item(value)
    where s.id = p_space_id
  ) names
  where name is not null;
$$;
