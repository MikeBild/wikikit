-- allowed_scopes becomes NOT NULL (v0.19.0): the stored array IS the ceiling.
--
-- Retires the transitional pre-0028 NULL-ceiling inheritance, where a
-- 'bootstrap' row without a stored ceiling inherited the provider's
-- allowedScopes at runtime. PROD carries no NULL rows anymore (verified
-- 2026-07-24: every row holds an explicit ceiling — the last NULL row was
-- deleted, and the allowlist bootstrap path has written explicit ceilings
-- since 0.18.0), so the backfill below is defensive only.
--
-- The backfill value is the minimal knowledge:read ceiling — deliberately
-- NOT the provider's allowed_scopes set: that set lives in runtime ENV
-- config and is not available to SQL, and silently granting more than read
-- to a row nobody vouched for would be an escalation. An operator raises a
-- backfilled row over PUT /v1/identities/{provider}/{subject}.
update public.wk_oauth_identities
   set allowed_scopes = '{knowledge:read}'
 where allowed_scopes is null;
--> statement-breakpoint
alter table public.wk_oauth_identities
  alter column allowed_scopes set not null;
