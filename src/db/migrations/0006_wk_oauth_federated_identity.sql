-- Multiple interactive identity providers for remote MCP OAuth.
-- Firebase rows stay valid; OIDC rows are uniquely anchored by provider + sub.
alter table public.wk_oauth_identities
  drop constraint if exists wk_oauth_identities_provider_subject_key;
alter table public.wk_oauth_identities
  drop constraint if exists wk_oauth_identities_pkey;
alter table public.wk_oauth_identities
  drop constraint if exists wk_oauth_identities_provider_check;
alter table public.wk_oauth_identities
  add constraint wk_oauth_identities_pkey primary key (provider, provider_subject);

alter table public.wk_oauth_login_states
  add column if not exists provider_id text,
  add column if not exists oidc_nonce text,
  add column if not exists oidc_code_verifier text;

alter table public.wk_oauth_authorization_codes
  drop constraint if exists wk_oauth_authorization_codes_principal_kind_check;
alter table public.wk_oauth_authorization_codes
  add constraint wk_oauth_authorization_codes_principal_kind_check
    check (principal_kind in ('api_key', 'firebase', 'oidc'));
alter table public.wk_oauth_access_tokens
  drop constraint if exists wk_oauth_access_tokens_principal_kind_check;
alter table public.wk_oauth_access_tokens
  add constraint wk_oauth_access_tokens_principal_kind_check
    check (principal_kind in ('api_key', 'firebase', 'oidc'));
alter table public.wk_oauth_refresh_tokens
  drop constraint if exists wk_oauth_refresh_tokens_principal_kind_check;
alter table public.wk_oauth_refresh_tokens
  add constraint wk_oauth_refresh_tokens_principal_kind_check
    check (principal_kind in ('api_key', 'firebase', 'oidc'));
