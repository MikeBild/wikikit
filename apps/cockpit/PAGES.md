# Writing a page in this console

The cockpit is a **wiki**. That is not a metaphor for the code — it is the
promise the whole interface makes, and every page keeps it or breaks it:

- A **space is a wiki.** `useSpace()` gives you its slug. Never let a page pick
  one, never put a space selector on a page — the sidebar owns that choice and
  the URL carries it.
- A **concept is a page**, written in Markdown. It is read as a rendered
  document, not as a form full of fields.
- **Editing is proposing.** Nothing a human writes becomes visible knowledge
  directly; saving creates a change proposal. Say "Submit change", never "Save",
  and send the operator to the change afterwards so they can see what they made.
- A **change is a document diff.** Approve, reject, request changes and split are
  decisions on a document, in the reviewer's language.
- **Sources are the evidence.** They are archived verbatim and read-only. Adding
  documents is how the wiki grows; the pages come back as changes to review.

Write the words a reader would use. "Pages", "Changes", "Sources", "Wikis". The
API says concept, proposal, source, space — keep that in the code, where it
matches the tables, and out of the interface.

## Two files per page

```
src/pages/<name>.tsx        the page component, one default-free named export
src/pages/<name>.logic.ts   anything worth testing without a DOM   (only if there is any)
```

A page module exports exactly one page component (CUI-PAGE-2), named in
`router.tsx`. If the page has a rule in it — how a status maps to a word, what
counts as an empty filter, how a diff is grouped — that rule goes in
`<name>.logic.ts` as a pure function, and `test/unit/cockpit-pages/<name>.test.ts`
covers it. A rule that needs a browser to prove it is a rule nobody proves.

## Never edit `app/nav.ts`

Drop a fragment at `apps/cockpit/nav-entries/<name>.json` instead:

```json
{
  "to": "/pages",
  "label": "Pages",
  "icon": "BookOpen",
  "scope": "knowledge:read",
  "group": "wiki",
  "api": ["/v1/spaces/{space}/concepts", "/v1/spaces/{space}/concepts/{slug}"]
}
```

`api` lists every documented path the page reaches, including through its
components. `test/unit/cockpit-navigation.test.ts` compares that declaration
against `ROUTES`, so a path you forget is a failed build, not a surprise 404.
The integrator merges the fragments into `nav.ts` — that way ten page agents
never touch one file.

## The API

Pages call `wk.*` from `@/api/wk` and **never** `fetch` or `api` directly.
Query keys come from `keys.*` in the same module, so a mutation invalidates by
the same name the query registered under.

Read `src/http/schemas.ts` for the actual response shapes before you write a
cell. Do not guess a field name; the schemas are the contract and the generated
`api/schema.d.ts` will not let you invent one.

## The four states, every time

Use `DataState` (or `DataTable`, which restates them for a `<tbody>`):

- **Loading** is a skeleton in the shape of the result — never the word
  "Loading…" (CUI-LOAD-1).
- **Error** keeps the server's own words and its `next_best_actions`, with
  `role="alert"`. A 403 gets no retry button; re-asking cannot change the answer
  (CUI-LOAD-2).
- **Empty** has a title, a description and — where one exists — the action that
  fills it. `EmptyState` requires the first two (CUI-LOAD-3).
- An empty result and a failed request never look the same (CUI-LOAD-4).

**A value nobody sent is `—`, never `0`** (CUI-SEV-2). A measured zero and an
unmeasured value are different facts.

## Status and colour

`STATUS_STATE` and `SEVERITY_STATE` in `@/lib/tokens` map a domain status to one
of five states; `Badge`'s prop is `tone` (`neutral | success | warning | danger |
accent | unknown`), **not** `variant` — a pasted `variant="destructive"` is a
type error on purpose. Never colour by `chart-N` (CUI-SEV-1). Never convey
anything by colour alone: a status has a word (CUI-A11Y-5).

The real vocabularies, from the migrations — do not invent members:

|                  |                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| change proposal  | `pending`, `approved`, `rejected`, `failed`, `split` — plus a `changes_requested` **boolean** on a still-pending change |
| ingest job       | `queued`, `running`, `done`, `failed`, `quota_blocked`                                                                  |
| claim            | `proposed`, `draft`, `verified`, `disputed`, `deprecated`                                                               |
| concept revision | `proposed`, `current`, `superseded`, `rejected`                                                                         |
| decision         | `proposed`, `active`, `superseded` — an in-force decision is `active`, never `current`                                  |
| relation         | `proposed`, `active`, `removed`                                                                                         |

## Lists

`DataTable` + `useTableView(listId, columns)` + `useUrlFilters(listId, specs)` +
`CursorPage`. A filtered list is an ADDRESS: the filter and the page belong in
the URL so it can be sent to somebody. `useTableView` remembers column choices
per list; it does not remember filters, because a stored filter is a list that
lies about what it is showing.

`wk.concepts.list` already answers "how does the wiki know this?" per row:
every item carries `evidence: {claims, uncited_claims, sources}` — the claims
the page makes, how many of those cite nothing, and how many distinct sources
back it. Only visible claims (`verified`, `disputed`, `deprecated`) are
counted; a `proposed` or `draft` claim belongs to a change, not to the page.
Render it from the list. Never fetch each page to recount it — that is one
request per row for a number the list already sent.

`evidence.claims === 0` is a **measured** zero: a page somebody wrote by hand,
with no sources behind it. It renders as `0`. `—` stays reserved for the value
nobody sent (CUI-SEV-2) — "makes no claims" and "we never asked" are different
facts about a page and must not look the same.

## Actions

- A link navigates and does nothing else; a button changes something
  (CUI-ACT-1). Never `<div onClick>` (CUI-ACT-3).
- One primary action per surface (CUI-ACT-4).
- A button never rewrites its own label while it works — compose `disabled` with
  a spinner (CUI-ACT-5).
- Every mutation with a consequence goes through `Confirm`, whose `details` prop
  restates the **exact** effect. Approving a change publishes knowledge; say so.
- Gate by scope with `useCan()` and wrap the disabled control in
  `DisabledReason` — a control that is missing teaches nothing, and a control
  that is disabled without a reason teaches less.

## Layout

- `Page` from `@/app/shell` is the frame. One per route, with a title, a
  one-sentence description of what the page is _for_, and its actions.
- Spacing is `flex` + `gap-*`, never `space-y-*` (CUI-LAYOUT-2).
- Container ladder: nothing → tabs → card → accordion. Cards do not nest
  (CUI-LADDER-1/2).
- Usable at 390px. Only a table scrolls sideways, inside its own container, and
  it must not take the row's own controls with it (CUI-RESP-1, CUI-LAYOUT-3).
- Every interactive element carries a `data-testid` (CUI-A11Y-4). The PROD
  verification checklist is driven by them.

## Markdown

`react-markdown` + `remark-gfm`, inside a `<div className="wk-doc">` — that class
restores the element styling Tailwind's preflight strips, for authored prose and
nowhere else. Import it only in the modules that render a document, so the
markdown chunk stays out of every other page's first paint. No `rehype-raw`, no
HTML passthrough: a source document is untrusted text.
