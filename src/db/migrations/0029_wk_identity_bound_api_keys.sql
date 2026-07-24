-- Close the SSO API-key loophole (v0.18.1): POST /v1/identity/sessions mints
-- a wk_api_keys row snapshotting the identity's ceiling, but nothing linked
-- that key back to its wk_oauth_identities grant — identity revocation could
-- not reach it and the snapshot never expired. The two nullable columns bind
-- such keys to their identity so that
--   - DELETE /v1/identities/{provider}/{subject} revokes bound keys with the
--     grant, and
--   - the auth path re-reads the CURRENT grant row per request (revoked or
--     deleted row = 401, like the OAuth-token path) and cuts the key's
--     effective scopes live against the current ceiling.
-- Plain operator keys keep both columns NULL and behave exactly as before.
alter table public.wk_api_keys
  add column if not exists identity_provider text;
alter table public.wk_api_keys
  add column if not exists identity_subject text;
alter table public.wk_api_keys
  drop constraint if exists wk_api_keys_identity_binding_check;
alter table public.wk_api_keys
  add constraint wk_api_keys_identity_binding_check
    check ((identity_provider is null) = (identity_subject is null));
--> statement-breakpoint
-- Identity revocation revokes bound keys by (provider, subject).
create index if not exists wk_api_keys_identity_active_idx
  on public.wk_api_keys (identity_provider, identity_subject)
  where identity_provider is not null and revoked_at is null;
--> statement-breakpoint
-- Drop the legacy vendor-named column default that pre-0005 deployments
-- still carry on wk_oauth_identities.provider. Every writer names the
-- provider explicitly; a default only invites silently mislabeled rows.
-- No-op on databases created from the committed migrations.
alter table public.wk_oauth_identities
  alter column provider drop default;
