-- A Firebase identity is an OAuth-login principal, never an API key. Its
-- explicit revocation invalidates all grants without exposing a shared secret.
create table if not exists public.wk_oauth_identities (
  provider_subject text primary key,
  email text not null,
  provider text not null default 'firebase' check (provider = 'firebase'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
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
  provider_subject text,
  provider_email text,
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
    check (principal_kind in ('api_key', 'firebase'));
alter table public.wk_oauth_access_tokens
  add column if not exists principal_kind text not null default 'api_key'
    check (principal_kind in ('api_key', 'firebase'));
alter table public.wk_oauth_refresh_tokens
  add column if not exists principal_kind text not null default 'api_key'
    check (principal_kind in ('api_key', 'firebase'));
