-- Identity grants become operator-manageable rows (admin REST, v0.18.0):
-- the wk_oauth_identities row is the single AuthZ truth for SSO logins.
--
-- display_name: operator-facing label surfaced by GET /v1/identities.
-- grant_source: who owns the row —
--   'bootstrap' — mirrored from the ENV allowlist at login (emergency
--                 bootstrap path; the allowlist keeps re-stamping it),
--   'signup'    — self-registered via WIKIKIT_OAUTH_ENABLE_SIGNUP,
--   'seed'      — written by the deploy seeder (which manages ONLY its rows),
--   'admin'     — operator REST (PUT /v1/identities/{provider}/{subject}).
-- Neither column is read for AuthZ decisions beyond the ceiling inheritance
-- rule: only 'bootstrap' rows with a NULL allowed_scopes still inherit the
-- provider's allowedScopes (transitional pre-0028 semantics).
alter table public.wk_oauth_identities
  add column if not exists display_name text not null default '';
alter table public.wk_oauth_identities
  add column if not exists grant_source text not null default 'bootstrap'
    check (grant_source in ('admin', 'seed', 'signup', 'bootstrap'));
--> statement-breakpoint
-- Backfill: every pre-0028 row carrying its own stored ceiling came from
-- self-signup (allowlist logins kept allowed_scopes NULL until now).
update public.wk_oauth_identities
   set grant_source = 'signup'
 where allowed_scopes is not null;
