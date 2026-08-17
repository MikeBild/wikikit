# Verifying the cockpit on a live installation

A browser checklist for the console, run against a deployment after a release.
`scripts/deploy/smoke.sh` already covers what `curl` can see; this covers what
only a browser can — that the wiki loop works, that the shell behaves at a
phone's width, and that a decision an operator makes actually lands.

Every step is **Do / Expect / Fail if**. A step with no "Fail if" is not a
check.

## 0. Setup

- **Do** — export the installation you are verifying. It is never written down
  in this repository:
  ```
  export WIKIKIT_DEPLOY_URL=https://<the installation>
  ```
- **Do** — run `scripts/deploy/smoke.sh` first. If it fails, stop: there is no
  point driving a browser at an installation whose headers are already wrong.
- **Do** — open devtools and paste the two helpers used throughout:
  ```js
  window.$t = (id) => document.querySelector(`[data-testid="${id}"]`)
  window.$ta = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)]
  ```
- **Do** — decide which wiki you are verifying in. Prefer a scratch space you
  own. **Every write below creates a change proposal, which is reviewable and
  reversible — but §5 approves one, and an approved change is knowledge.** If
  you are on an installation you do not own, stop before §5 and say so in the
  result.
- **Expect** — `$t('page-title')` resolves once you are signed in.
- **Fail if** — the version in `/ready` is not the version you released. The
  deployer has not rolled forward; nothing below is a verification of the new
  release.

## 1. Sign-in

- **Do** — open `$WIKIKIT_DEPLOY_URL/cockpit/` in a fresh private window.
- **Expect** — the splash reads `wikikit` and offers exactly one control,
  `$t('sign-in')`.
- **Fail if** — an API-key field is on this screen. There is one sign-in
  surface, and it is the server-rendered funnel.
- **Do** — click it.
- **Expect** — you land on the funnel, which offers a choice of method and asks
  for no credential yet.
- **Do** — complete the sign-in.
- **Expect** — you land back on `/cockpit/`, not on `/cockpit` with a lost
  path. The sidebar renders.
- **Fail if** — you land on the funnel again. The session cookie did not stick
  — check `Secure`/`__Host-` against the scheme the proxy terminates.
- **Do** — now open `$WIKIKIT_DEPLOY_URL/cockpit/decisions` directly in a second
  private window and sign in from there.
- **Expect** — after signing in you are on `/cockpit/decisions`, not on the home
  page. `return_to` survived the round trip.

## 2. The shell

- **Do** — read the sidebar.
- **Expect** — three blocks: an unlabelled home entry, **Wiki**, and
  **Installation** (separated, collapsed).
- **Expect** — `$ta('nav-api-keys').length` is `0` unless your session holds
  `admin`. Check what `$t('operator-scopes')` says and confirm the two agree.
- **Fail if** — a nav entry is offered that every request behind it refuses.
- **Do** — click `$t('sidebar-trigger')`.
- **Expect** — the sidebar collapses to an icon rail and every entry still
  names itself on focus (tab to one).
- **Fail if** — an icon on the rail has no reachable name.
- **Do** — `$t('theme-toggle')` → **Dark**. Then reload.
- **Expect** — the page paints dark with no white frame first.
- **Fail if** — a white flash. The pre-paint script did not run.
- **Do** — with dark still chosen, sign out and look at the sign-in funnel.
- **Expect** — the funnel is dark too.
- **Fail if** — the funnel is light. The `wk-cockpit-theme` cookie is not
  reaching the server, or `vary: cookie` is missing and a proxy cached the
  light copy.
- **Do** — sign back in.
- **Expect** — the theme is still dark. Signing out does not reset it.

## 3. The wiki switcher

_Skip if this credential can see only one wiki._

- **Do** — open `$t('space-switcher')` and choose another wiki.
- **Expect** — the URL carries `?space=<slug>` and the page reloads its content.
- **Do** — copy that URL into another tab.
- **Expect** — the same wiki opens. The choice is an address, not a preference.
- **Fail if** — the second tab opens a different wiki. Stored state is
  overriding the URL.

## 4. Reading

- **Do** — open **Pages** and click a page.
- **Expect** — a rendered Markdown document: headings, lists and code read as
  such.
- **Fail if** — raw Markdown, or raw HTML from a source rendering as markup.
- **Do** — find the claims panel and expand one claim's citation.
- **Expect** — a verbatim quote from a source, and the source is named.
- **Fail if** — a claim shows no citation and looks the same as one that does.
  A claim without evidence is the one thing this product must never present as
  knowledge.
- **Do** — open **Search**, search for a term you know is in a source but not
  yet in an approved page.
- **Expect** — approved hits and source-evidence hits are visibly different,
  and the source-evidence tier is labelled as not-yet-knowledge.
- **Fail if** — the two tiers look alike, or a `<mark>` renders as literal
  markup.

## 5. The loop: edit → proposal → review

This is the product. If nothing else is checked, check this.

- **Do** — on a page, click **Edit**.
- **Expect** — a Markdown editor with a live preview, and the submit button
  reads **Submit change** — not "Save".
- **Fail if** — it says Save. The interface would be promising something the
  server does not do.
- **Do** — make a small, obviously-yours edit (add a sentence naming the
  release you are verifying). Submit.
- **Expect** — a toast, and you land on `/cockpit/decisions/proposals/<id>`.
- **Do** — read the proposal.
- **Expect** — a line diff showing your sentence added; the lint result is
  present; the claims and their citations are listed.
- **Fail if** — the diff is empty, or a lint failure blanked the diff. Lint
  never blocks the diff.
- **Do** — note the public review URL shown on the page and open it in a
  private window.
- **Expect** — the public review page loads and asks for a key. It is the same
  proposal.
- **Do** — back in the cockpit, click **Request changes**.
- **Expect** — a dialog that will not submit without a note.
- **Fail if** — it submits with an empty note.
- **Do** — cancel. Now click **Approve**.
- **Expect** — a confirmation that states the exact effect — how many concepts
  this publishes — before anything happens.
- **Fail if** — the confirmation is generic, or there is none.
- **Do** — confirm.
- **Expect** — the change reads `approved`, and the page now shows your
  sentence.
- **Fail if** — the queue still shows it as pending after a refresh. The
  mutation did not invalidate its read.
- **Do** — if you hold only `knowledge:review` and not `knowledge:approve`,
  check the Approve button instead of pressing it.
- **Expect** — disabled, with a stated reason naming the missing scope.
- **Fail if** — disabled with no reason, or hidden entirely.

## 6. Adding documents

- **Do** — **Sources** → **Add documents**, and ingest something small.
- **Expect** — a job appears and progresses; when it finishes, the page says
  the synthesised pages are waiting in Changes, and links there.
- **Fail if** — the job spins forever after reaching a terminal state, or a
  `quota_blocked` job is reported as finished. It is parked, not done.
- **Do** — follow the link.
- **Expect** — new pending changes, from your ingest.

## 7. The four states

Pick any list page.

- **Do** — reload and watch the first paint.
- **Expect** — skeleton rows, not the word "Loading…".
- **Do** — apply a filter that matches nothing.
- **Expect** — an empty state with a title and a description, visibly different
  from an error.
- **Do** — open a page whose data needs a scope you do not hold (**System** is
  the reliable one: some cards are admin-only).
- **Expect** — the card is present and shows the server's own refusal, with no
  retry button.
- **Fail if** — a 403 renders a retry button, or the card disappears. "Not
  yours" and "not there" are different facts.

## 8. A phone

- **Do** — resize to **390 × 844** and walk every nav entry.
- **Expect** — the sidebar is an off-canvas sheet; `$t('sidebar-trigger')`
  opens it.
- **Expect** — on each page: `document.documentElement.scrollWidth <=
document.documentElement.clientWidth`.
- **Fail if** — the document scrolls sideways anywhere. Only a table may, and
  only inside its own container:
  ```js
  $ta('page').length &&
    [...document.querySelectorAll('table')].every((t) => {
      for (let n = t.parentElement; n; n = n.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(n).overflowX)) return true
      }
      return false
    })
  ```
  must be `true`.
- **Do** — on a list, reach a row's action.
- **Fail if** — the row's controls scrolled away with the table.
- **Do** — open the approve confirmation at this height.
- **Fail if** — its own buttons are off-screen.

## 9. Teardown

- **Do** — if you approved a verification edit in §5, submit and approve a
  change reverting it, or leave a note saying it is there deliberately.
- **Fail if** — you leave an unexplained sentence in somebody's knowledge base.
- **Do** — sign out from the cockpit.
- **Expect** — the splash returns and a reload does not restore the session.
- **Fail if** — a reload signs you back in. The cookie was not revoked.

## Result template

```
WikiKit cockpit — production verification
Version:   <served version>
Wiki:      <space slug>
Date:      <date>
Sections:  1 ✓  2 ✓  3 ✓  4 ✓  5 ✓  6 ✓  7 ✓  8 ✓  9 ✓
Skipped:   <section + why>
Failures:  <section, step, what happened>
```

A skipped section is reported, never omitted. A green run of eight sections is
not a green run.
