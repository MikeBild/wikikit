-- OAuth 2.1 authorization server for remote MCP clients such as ChatGPT.
--
-- API keys remain WikiKit's operator credential. The authorization endpoint
-- validates one without persisting its plaintext, then issues short-lived,
-- scoped OAuth tokens. Codes and tokens are stored only as peppered HMACs,
-- exactly like wk_api_keys.

create table if not exists public.wk_oauth_clients (
  client_id text primary key,
  client_name text not null default 'MCP client',
  redirect_uris text[] not null,
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method = 'none'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.wk_oauth_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  client_id text not null references public.wk_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  scopes text[] not null,
  code_challenge text not null,
  resource text not null,
  principal_name text not null,
  principal_space_id uuid references public.wk_spaces(id) on delete cascade,
  principal_key_id text not null,
  principal_key_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists wk_oauth_codes_expiry_idx
  on public.wk_oauth_authorization_codes (expires_at)
  where consumed_at is null;

create table if not exists public.wk_oauth_access_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  client_id text not null references public.wk_oauth_clients(client_id) on delete cascade,
  scopes text[] not null,
  resource text not null,
  principal_name text not null,
  principal_space_id uuid references public.wk_spaces(id) on delete cascade,
  principal_key_id text not null,
  principal_key_hash text not null,
  family_id uuid not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists wk_oauth_access_expiry_idx
  on public.wk_oauth_access_tokens (expires_at)
  where revoked_at is null;
create index if not exists wk_oauth_access_family_idx
  on public.wk_oauth_access_tokens (family_id);

create table if not exists public.wk_oauth_refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  client_id text not null references public.wk_oauth_clients(client_id) on delete cascade,
  scopes text[] not null,
  resource text not null,
  principal_name text not null,
  principal_space_id uuid references public.wk_spaces(id) on delete cascade,
  principal_key_id text not null,
  principal_key_hash text not null,
  family_id uuid not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists wk_oauth_refresh_expiry_idx
  on public.wk_oauth_refresh_tokens (expires_at)
  where revoked_at is null;
create index if not exists wk_oauth_refresh_family_idx
  on public.wk_oauth_refresh_tokens (family_id);
