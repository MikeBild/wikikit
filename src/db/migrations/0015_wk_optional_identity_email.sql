-- The immutable OIDC subject is the identity anchor. Email is optional and is
-- persisted only when the provider explicitly marks it as verified.
alter table public.wk_oauth_identities
  alter column email drop not null;
