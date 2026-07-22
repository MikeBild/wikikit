-- External identities are OAuth-login principals, never API keys. Provider
-- ids are opaque deployment slugs; revocation invalidates grants without
-- exposing a shared credential or introducing a provider-specific schema.
create table if not exists public.wk_oauth_identities (
  provider_subject text not null,
  email text not null,
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (provider, provider_subject)
);

create table if not exists public.wk_oauth_login_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  client_id text not null references public.wk_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  scopes text[] not null,
  code_challenge text not null,
  resource text not null,
  client_state text,
  provider_id text,
  provider_subject text,
  provider_email text,
  oidc_nonce text,
  oidc_code_verifier text,
  authenticated_at timestamptz,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists wk_oauth_login_states_expiry_idx
  on public.wk_oauth_login_states (expires_at)
  where consumed_at is null;

alter table public.wk_oauth_authorization_codes
  add column if not exists principal_kind text not null default 'api_key'
    check (principal_kind in ('api_key', 'identity'));
alter table public.wk_oauth_access_tokens
  add column if not exists principal_kind text not null default 'api_key'
    check (principal_kind in ('api_key', 'identity'));
alter table public.wk_oauth_refresh_tokens
  add column if not exists principal_kind text not null default 'api_key'
    check (principal_kind in ('api_key', 'identity'));
