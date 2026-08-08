# cockpit-ui

Contract: cockpit-ui
Tokens-File: contract/cockpit-ui.css
Tokens-Digest: sha256:4ca18a25cbcfa991384c86a72051c5651b1a8861594486ed902145781d47a36e

WikiKit's cockpit implements the `cockpit-ui` design contract. Nothing imports
this file. It is law, carried by copy.

## What this is, and what it is deliberately not

The contract is a **look, a user flow and a design system** — carried as text,
never as code. WikiKit is an autonomous product: its own server, its own
database, its own OIDC client, its own binary, its own releases. Implementing
this contract does not change that and does not ask it to.

Two files carry it:

|                           |                                                          |
| ------------------------- | -------------------------------------------------------- |
| `contract/COCKPIT-UI.md`  | this file — the rules, each with an ID                   |
| `contract/cockpit-ui.css` | the token bytes, whose sha256 is the contract's identity |

There is **no shared package, no shared component, no shared build and no shared
deployment.** WikiKit implements this contract with its own code. Where WikiKit
genuinely needs to differ, it differs, and says so in `apps/cockpit/PAGES.md`.

This file **never names a test.** Enforcement lives in
`contract/conformance.cockpit-ui.json`, which maps each rule ID to the local test
that holds it — or to nothing, with a stated reason. An empty `enforced_by` with
a real `why` is a truthful entry, not a gap to be papered over.

## 1. Tokens

- **CUI-TOKEN-1** — The three regions delimited by the `cockpit-ui` sentinels
  in `apps/cockpit/src/index.css` are byte-identical to `contract/cockpit-ui.css`:
  `tokens-light`, `tokens-dark`, `theme-map`, in that order.
- **CUI-TOKEN-2** — The names declared in `tokens-light` are exactly the names
  listed below.
- **CUI-TOKEN-3** — A custom property declared outside the sentinels carries the
  `--wk-` prefix. The type stack of §2 is the only exception.

The tokens are shadcn's **names** with the contract's **values**, so a component
pasted from the registry works unmodified and still looks like it belongs.

### Names

```
background, foreground, surface, card, card-foreground, popover,
popover-foreground, primary, primary-foreground, secondary,
secondary-foreground, muted, muted-foreground, accent, accent-foreground,
destructive, warning, success, border, input, ring, chart-1, chart-2, chart-3,
chart-4, chart-5, radius, sidebar, sidebar-foreground, sidebar-primary,
sidebar-primary-foreground, sidebar-accent, sidebar-accent-foreground,
sidebar-border, sidebar-ring
```

### There is no version number

The identity of this contract is the digest of its bytes, and `Tokens-Digest`
above is it. A hand-typed version can claim agreement while the bytes diverge; a
digest can only agree when the bytes agree. Any change to
`contract/cockpit-ui.css` — a changed value, an added name, a removed name alike
— is a new digest.

## 2. Type

- **CUI-TYPE-1** — `--font-sans` carries the contract's stack, compared by
  normalised value and never by bytes. It lives **outside** the sentinels: a
  formatter wraps the declaration differently in different checkouts, and a
  contract a formatter can break is a contract nobody keeps. Further families
  (`--font-mono`, `--font-heading`) are WikiKit's own.

## 3. Theme

- **CUI-THEME-1** — The operator's choice is one of `light`, `dark`, `system`,
  stored under `wk-cockpit-theme`.
- **CUI-THEME-2** — `system` is the **absence** of the stored key, never the
  string `"system"`. A stored word and an unexpressed preference are different
  facts.
- **CUI-THEME-3** — A blocking pre-paint script applies the resolved scheme
  before first paint. The console never renders a frame in the wrong scheme.
- **CUI-THEME-4** — The resolved scheme is carried by the `dark` class on the
  document element.
- **CUI-THEME-5** — Signing out does not reset the theme.

## 4. Mount and delivery

- **CUI-MOUNT-1** — The console is served under the `/cockpit` path prefix of
  WikiKit's own origin, so the session cookie is same-origin and no CORS or
  bearer token is involved.
- **CUI-MOUNT-2** — Fingerprinted assets are immutable; `index.html` is `no-cache`.
- **CUI-MOUNT-3** — Unknown paths under the prefix fall back to `index.html`.
- **CUI-MOUNT-4** — The console runs under a strict CSP. The pre-paint script of
  CUI-THEME-3 is the only inline script.

## 5. Markers

- **CUI-MARK-1** — The served `index.html` declares
  `<meta name="cockpit-ui-contract" content="cockpit-ui">` and
  `<meta name="cockpit-ui-digest" content="sha256-…">`, the latter **derived at
  build time from the bytes of the tokens file** and never hand-typed.
- **CUI-MARK-2** — The shell's outermost element carries `data-cockpit-ui`.

No test inside this repository can prove its bytes match another
implementation's. The derived digest is what makes divergence _visible_ instead:
different bytes announce a different string, in the DOM, in every screenshot.

## 6. What a page is

- **CUI-PAGE-1** — One page answers one question.
- **CUI-PAGE-2** — One module exports one page.
- **CUI-LADDER-1** — Pick the first container that fits, going down: nothing →
  tabs → card → accordion. Every step down costs the reader something.
- **CUI-LADDER-2** — A card is not a container for one sentence, and cards do not
  nest. If something inside a card needs its own frame, the card is a page section.
- **CUI-LADDER-3** — One empty state per surface, not per card.

## 7. Actions

- **CUI-ACT-1** — A link navigates: the URL changes and nothing else does. A
  button changes something.
- **CUI-ACT-2** — A row of actions is one kind or the other.
- **CUI-ACT-3** — Never a `<div onClick>`. A control that acts is a `<button>`; a
  control that navigates is an `<a>`.
- **CUI-ACT-4** — One primary action per surface.
- **CUI-ACT-5** — A button never rewrites its own label while it works. Compose a
  spinner with `disabled` and leave the label alone, or the button the reader
  aimed at is gone by the time they arrive.

## 8. Words

- **CUI-WORDS-1** — Each surface carries the length it is for: a page description
  is one sentence about what the page is _for_; a field description is what must
  be known before acting; a tooltip is a definition, a unit or a shorthand; a
  popover is a paragraph; an alert is a consequence.
- **CUI-WORDS-2** — A native `title=` attribute is not a tooltip. It is invisible
  on touch and unreachable by keyboard.

## 9. Severity and colour

- **CUI-SEV-1** — A severity never wears a chart series' name. `destructive`,
  `warning`, `success` — never `chart-N`. It renders identically, which is
  exactly why nothing on screen says it is wrong.
- **CUI-SEV-2** — A value nobody sent is not zero. `—` for a missing number,
  never `0`. A measured zero and an unmeasured value are different facts and must
  read differently.

## 10. The four states of anything that loads

- **CUI-LOAD-1** — Loading is a skeleton in the shape of the result, never the
  word "Loading…", which is one line high where the result is forty.
- **CUI-LOAD-2** — An error carries the server's own words, with `role="alert"`.
  A refusal names counts; rewriting it drops them.
- **CUI-LOAD-3** — An empty state has a title, a description and, where one
  exists, the action that fills it.
- **CUI-LOAD-4** — An empty result and a failed request never look the same.

## 11. Layout

- **CUI-LAYOUT-1** — The console is an app shell: the panes scroll, the document
  does not. Every element between `body` and the scrolling pane is bounded to the
  viewport.
- **CUI-LAYOUT-2** — Spacing is `flex` + `gap-*`.
- **CUI-LAYOUT-3** — A table wide enough to overflow scrolls inside its own
  container, never by pushing the page sideways.

## 12. Responsiveness

- **CUI-RESP-1** — A new or touched page is usable at 390px wide. A table may
  scroll horizontally inside its own container; nothing else may, and a table may
  not take the row's own controls with it.

## 13. Accessibility

- **CUI-A11Y-1** — Every dialog has a title, even if it is visually hidden.
- **CUI-A11Y-2** — Focus is trapped while a dialog is open and lands somewhere
  useful when it closes — never on `<body>`.
- **CUI-A11Y-3** — A dialog that owns a mutation cannot be dismissed while the
  request is in flight.
- **CUI-A11Y-4** — Every interactive element carries a `data-testid`.
- **CUI-A11Y-5** — Nothing is conveyed by colour alone. A status has a word; a
  warning has an icon.

## 14. Navigation

- **CUI-NAV-1** — Navigation is a declarative table, not a hand-written tree.
  Each entry states at least its route, its label, its icon, the scope that
  reveals it and the group it sits in.
- **CUI-NAV-2** — Each entry states the API paths its page reaches, and that
  declaration is compared against what the page actually calls. A navigation
  table nobody checks is a comment.

## 15. AI output

- **CUI-AI-1** — A model's claim is not a measurement, and never renders in a
  token that means "healthy" or "confirmed".
- **CUI-AI-2** — Model identity and generation time are shown wherever model
  output is. Confidence is a number with its scale stated, never a bare
  colour-coded bar.
- **CUI-AI-3** — Model output states what it was shown. What cannot be traced
  cannot be argued with.
- **CUI-AI-4** — Accept/reject renders only where an endpoint actually records
  the answer. An affordance that discards the operator's judgement is worse than
  none.

## How a token change travels

`contract/cockpit-ui.css` arrives by copy. It is never edited in place to try a
colour: a value changed here and nowhere else is a console that no longer
implements the contract it claims to.

1. Replace `contract/cockpit-ui.css` wholesale with the new bytes.
2. `shasum -a 256 contract/cockpit-ui.css` → paste into `Tokens-Digest` above;
   append a Ledger row.
3. Copy the three sentinel regions into `apps/cockpit/src/index.css` and update
   `apps/cockpit/src/lib/tokens.ts` (the TS restatement SVG strokes and chart
   series read, which no Tailwind class can serve).
4. `bun run build:cockpit` — regenerates `assets/cockpit` **and**
   `src/cockpit-embedded.ts`.
5. `bun run gate` — the contract test compares `index.css` against the contract,
   the theme test compares `tokens.ts` against both, and `check:cockpit-drift`
   fails on a stale bundle.
6. Commit every touched file together. A digest that has landed without its
   tokens is worse than no digest.

## Ledger

| Date       | Digest            | Change                                                                                                           |
| ---------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| 2026-08-08 | `sha256:4ca18a25` | Contract adopted. WikiKit's cockpit is built on these bytes from its first commit; no value changed on adoption. |
