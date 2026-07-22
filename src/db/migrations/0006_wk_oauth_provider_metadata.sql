-- Keep provider metadata structural and uniformly indexed. The columns are
-- repeated with IF NOT EXISTS so this step is safe after a partially completed
-- bootstrap without introducing an alternate schema shape.
alter table public.wk_oauth_login_states
  add column if not exists provider_id text,
  add column if not exists oidc_nonce text,
  add column if not exists oidc_code_verifier text;

alter table public.wk_oauth_identities
  drop constraint if exists wk_oauth_identities_provider_check;
alter table public.wk_oauth_identities
  add constraint wk_oauth_identities_provider_check
    check (provider ~ '^[a-z0-9][a-z0-9-]{0,62}$');

create index if not exists wk_oauth_identities_provider_active_idx
  on public.wk_oauth_identities (provider, last_seen_at desc)
  where revoked_at is null;
