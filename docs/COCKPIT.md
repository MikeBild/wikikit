# The cockpit

WikiKit's one human interface: a web console the binary serves at `/cockpit`,
on the same origin and at the same version as the API it talks to.

## What it is

**A wiki.** That is not decoration on an admin panel — it is the model the whole
console is built on, because it is the model a reader already has:

| The console says | The API says      |                                   |
| ---------------- | ----------------- | --------------------------------- |
| a wiki           | a space           | everything belongs to exactly one |
| a page           | a concept         | Markdown, read as a document      |
| a change         | a change proposal | what an edit becomes              |
| a source         | a source          | archived verbatim, read-only      |

So editing a page does not save a page. It submits a change, and somebody with
`knowledge:approve` decides whether that becomes knowledge. The console says
**Submit change**, never Save, because the second word would promise something
the server does not do.

The three sidebar blocks follow from that: where you are (home), the wiki
itself, and — folded away — the installation that hosts it.

## Why the binary serves it

A console that needs a second deployment is a console that is out of date on the
day it matters, and a console on another origin needs CORS, a bearer token in
JavaScript, and a second place to leak it from. Same origin, same process, same
version: the bundle and the API it calls cannot disagree, because they ship as
one artifact.

Mechanically: `apps/cockpit` is built by Vite into `assets/cockpit`, and
`scripts/gen-embedded-cockpit.ts` packs that into `src/cockpit-embedded.ts` as
base64 — `bun build --compile` produces one file, so a `readFileSync` against
`assets/cockpit` inside it would resolve to a path that does not exist on the
operator's machine. `src/cockpit.ts` reads on-disk first (so a developer sees a
rebuild without restarting) and the embed second (so a binary works at all).

Both generated artifacts are committed and drift-checked:
`bun run check:cockpit-drift` rebuilds and fails on any diff. It runs in the
gate and in CI, because a stale embed ships last week's console against this
week's API and nothing at runtime notices.

## Signing in

The console holds no credential. It cannot: a token in JavaScript is a token
any script on the page can read.

1. The bundle loads unauthenticated — it contains no knowledge — and asks
   `GET /v1/session`. That endpoint **never answers 401**: an anonymous tab gets
   `{"session": null}`, because "nobody is signed in" is an answer the console
   renders, not a failure it recovers from.
2. Signing in is a **navigation**, not a form: the button is an anchor to
   `GET /v1/identity/cockpit-login?return_to=<path under /cockpit>`. There is
   one sign-in surface in this product — the server-rendered funnel — and an
   SPA form would be a second one that drifts from it. It is also the only
   surface that _can_ serve SSO, since an OIDC round trip is a sequence of
   redirects a single-page app cannot participate in.
3. That mints a login state with `purpose = 'cockpit'` (migration 0032) and
   hands the browser to the same provider chooser every other sign-in uses. The
   cockpit is deliberately **not** an OAuth client: consent exists so a _third
   party_ can be told what it is about to be granted, and the console is not a
   third party. A consent screen for one's own console is a screen that teaches
   people to click through consent screens.
4. On success the funnel sets the operator-session cookie — HttpOnly,
   `SameSite=Lax`, `__Host-` prefixed under https — and redirects back to
   `return_to`. That value is validated as a same-origin path under `/cockpit`;
   anything else falls back to `/cockpit/`.

The cookie is a **fallback** credential on ordinary `/v1` routes: it is
consulted only when a request carries no `Authorization` and no `X-API-Key`
header, so no existing client's 401 or 403 changes shape. Unsafe methods
additionally require a same-origin `Origin` header — `SameSite=Lax` does not
cover every write on its own, and a CSRF token would have to reach JavaScript,
which is the one property the cookie was chosen to avoid.

Scopes are re-derived on every read: an identity grant narrowed after a session
was minted narrows that session too. The console mirrors the implication table
in `apps/cockpit/src/lib/scopes.ts`, and `test/unit/cockpit-scopes.test.ts`
compares the two over the full cross product — a console more permissive than
its server offers buttons that 403; a stricter one hides work somebody is
entitled to do, and nothing on screen says so.

## Design

The console implements the `cockpit-ui` contract: `contract/COCKPIT-UI.md` is
the rules, `contract/cockpit-ui.css` is the token bytes, and the sha256 of that
file is the contract's identity. The three sentinel regions in
`apps/cockpit/src/index.css` are byte-identical to it, `lib/tokens.ts` restates
the same table as data (an SVG stroke cannot read a Tailwind class), and
`test/unit/cockpit-ui-contract.test.ts` compares all three. The built
`index.html` announces the digest in a `<meta>` tag, derived at build time —
a hand-typed version number cannot notice that the bytes underneath it changed.

Stack: React 19, TanStack Router (code-based, `basepath: '/cockpit'`), TanStack
Query, Tailwind v4, shadcn primitives vendored into `components/ui`, and
`openapi-fetch` typed against `docs/openapi.json`. Pages call the `wk.*` facade
and never `fetch` directly, so `app/nav.ts`'s per-page `api` declaration is
something a test can check against `ROUTES`.

The CSP is stricter than anything else WikiKit serves: no external bytes at
all, `connect-src 'self'`, and **no `unsafe-inline` in `script-src`**. The one
inline block — the pre-paint theme script — is admitted by the sha256 of the
bytes actually being served, computed per deployment so the header and the
document cannot drift apart.

The theme choice (`wk-cockpit-theme`; `system` is the _absence_ of the key) is
mirrored into a non-HttpOnly cookie of the same name, so the script-free
sign-in funnel can render in the scheme the operator already chose. It carries
a colour preference and nothing else.

## Working on it

```
bun run dev                # the API on :4060
bun run dev:cockpit        # Vite on :4061, proxying /v1 and friends to the API
```

`WIKIKIT_DEV_ORIGIN` overrides the proxy target. It is read by
`apps/cockpit/vite.config.ts` and never by the server, so it is not part of the
service's configuration surface and does not appear in `.env.example`.

```
bun run build:cockpit      # vite build → assets/cockpit → src/cockpit-embedded.ts
bun run gen:cockpit-types  # regenerate api/schema.d.ts from docs/openapi.json
bun run check:cockpit-drift
```

`apps/cockpit/PAGES.md` is the contract for writing a page: two files, a nav
fragment instead of editing `nav.ts`, the four load states, and the real status
vocabularies. Read it before adding a surface.

## Verifying a deployment

`scripts/deploy/smoke.sh` covers what curl can see — the shell is served, its
CSP is hash-based, the deep route falls back, `/v1/session` answers null, the
chooser renders and asks for no credential on step one.

`scripts/deploy/verify-cockpit-prod.md` covers what only a browser can: the
sign-in round trip with a deep `return_to`, the theme surviving sign-out and
reaching the funnel, and the loop the product turns on — edit a page, submit a
change, read its diff, approve it, see the page change. Both take the
installation from `$WIKIKIT_DEPLOY_URL`; no deployment URL is written down in
this repository.
