-- External identities are represented uniformly regardless of login protocol.
-- This release intentionally invalidates in-flight external OAuth grants and
-- browser sessions; users authenticate again through the configured provider.
delete from public.wk_oauth_authorization_codes where principal_kind <> 'api_key';
delete from public.wk_oauth_access_tokens where principal_kind <> 'api_key';
delete from public.wk_oauth_refresh_tokens where principal_kind <> 'api_key';
delete from public.wk_oauth_operator_sessions where principal_kind <> 'api_key';

alter table public.wk_oauth_authorization_codes
  drop constraint if exists wk_oauth_authorization_codes_principal_kind_check;
alter table public.wk_oauth_authorization_codes
  add constraint wk_oauth_authorization_codes_principal_kind_check
    check (principal_kind in ('api_key', 'identity'));

alter table public.wk_oauth_access_tokens
  drop constraint if exists wk_oauth_access_tokens_principal_kind_check;
alter table public.wk_oauth_access_tokens
  add constraint wk_oauth_access_tokens_principal_kind_check
    check (principal_kind in ('api_key', 'identity'));

alter table public.wk_oauth_refresh_tokens
  drop constraint if exists wk_oauth_refresh_tokens_principal_kind_check;
alter table public.wk_oauth_refresh_tokens
  add constraint wk_oauth_refresh_tokens_principal_kind_check
    check (principal_kind in ('api_key', 'identity'));

alter table public.wk_oauth_operator_sessions
  drop constraint if exists wk_oauth_operator_sessions_principal_kind_check;
alter table public.wk_oauth_operator_sessions
  drop constraint if exists wk_oauth_operator_sessions_check;
alter table public.wk_oauth_operator_sessions
  add constraint wk_oauth_operator_sessions_principal_kind_check
    check (principal_kind in ('api_key', 'identity'));
alter table public.wk_oauth_operator_sessions
  add constraint wk_oauth_operator_sessions_provider_check check (
    (principal_kind = 'api_key' and provider_id is null and provider_subject is null)
    or
    (principal_kind = 'identity' and provider_id is not null and provider_subject is not null)
  );
