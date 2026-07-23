-- Per-identity permission ceiling for self-signup (WIKIKIT_OAUTH_ENABLE_SIGNUP).
-- NULL means the identity is admitted through the provider allowlist and
-- inherits the provider's allowed_scopes. A non-null array is the identity's
-- own ceiling, written exactly once when an unknown identity self-registers
-- at the minimal knowledge:read role. Allowlist logins reset the column to
-- NULL so removing an allowlist entry keeps revoking access.
alter table public.wk_oauth_identities
  add column if not exists allowed_scopes text[];
