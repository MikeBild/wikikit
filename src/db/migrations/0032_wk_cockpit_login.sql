-- The cockpit's sign-in reuses the OAuth login funnel, without being an OAuth client.
--
-- WHY not register the cockpit as a client: the funnel already knows how to
-- prove who somebody is — provider chooser, SSO round trip, API-key form,
-- operator session cookie. What follows it, the consent screen, exists so a
-- THIRD party can be told what it is about to be granted. The cockpit is not a
-- third party; it is this installation's own console, on this installation's own
-- origin, and asking an operator to consent to their own console would be a
-- screen that teaches people to click through consent screens.
--
-- So a login state grows a purpose. `oauth` is every state the funnel has ever
-- minted and carries the full authorization request; `cockpit` carries only
-- where to return to afterwards. The CHECK makes the two shapes mutually
-- exclusive rather than merely differently populated: a cockpit state with a
-- redirect_uri would be an authorization request nobody validated, and that is
-- exactly the row an open-redirect needs.
alter table public.wk_oauth_login_states
  add column if not exists purpose text not null default 'oauth',
  add column if not exists return_to text;

-- The OAuth columns were NOT NULL because, until now, every row was an
-- authorization request. A cockpit state has no client, no redirect_uri, no
-- requested scopes, no PKCE challenge and no resource — and must not be able to
-- pretend it has.
alter table public.wk_oauth_login_states
  alter column client_id drop not null,
  alter column redirect_uri drop not null,
  alter column scopes drop not null,
  alter column code_challenge drop not null,
  alter column resource drop not null;

alter table public.wk_oauth_login_states
  drop constraint if exists wk_oauth_login_states_purpose_shape;

alter table public.wk_oauth_login_states
  add constraint wk_oauth_login_states_purpose_shape check (
    (purpose = 'oauth'
      and client_id is not null
      and redirect_uri is not null
      and scopes is not null
      and code_challenge is not null
      and resource is not null
      and return_to is null)
    or
    (purpose = 'cockpit'
      and client_id is null
      and redirect_uri is null
      and scopes is null
      and code_challenge is null
      and resource is null
      and return_to is not null)
  );
