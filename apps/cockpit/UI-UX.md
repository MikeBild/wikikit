# WikiKit Cockpit UI/UX

The Cockpit follows the questions an end user actually has. It must not expose
internal pipeline stages as navigation, a compatibility route, or a hidden
shortcut around human review.

## End-user model

- **Start — Where is work waiting?** One global search and one compact table of
  open human tasks provide direct entry points without dashboard summaries.
- **Wikis — Which knowledge areas exist?** Wikis are a primary destination;
  every visible wiki appears in the same list and can be opened directly.
- **Inbox — What arrived?** Files, URLs and pasted text wait here until their
  destination is clear.
- **Pages and Search — What do we know?** Published knowledge and archived-only
  evidence are visibly different.
- **Decisions — What needs a human choice?** Only proposals and inbox triage
  belong here. Reports describe work; they never create another decision.
- **Check — What did the read-only inspection observe?** Informational findings
  and actionable repairs are separate and each action explains its effect.
- **Sources and decision log — Where did this come from?** Immutable evidence,
  its current uses and settled choices remain traceable.

## Navigation and routes

- `/` contains global search and the global open-task table.
- `/search` searches every visible wiki by default. A user may narrow results
  to the current wiki; grounded Q&A is available only in that narrower scope.
- `/spaces` is the complete wiki list and is not installation-only navigation.
- `/decisions` is the single attention queue for proposals and triage.
- `/care` contains check observations; findings are not decisions.
- `/decisions/proposals/:id` is the full proposal review surface.
- `/decision-log` contains recorded decisions.
- Removed routes are intentionally not redirected. The not-found page returns
  people to current navigation.

## Interaction rules

- Critical effects, rejection history, citations and source-lock state are
  visible without a tooltip.
- Source bytes are immutable. Corrections enter as new captured material.
- A grounded answer can become a knowledge proposal only through ordinary
  ingest and human review. Briefings and health reports remain history.
- Attention cards may be deferred or removed from the operator queue without
  mutating the underlying knowledge object.
- Tables must collapse secondary columns on narrow screens; the page itself
  never gains horizontal scrolling.
- Empty queues are good news, missing measurements use an em dash, and color is
  never the only carrier of state.

## Visual language

The existing semantic tokens, Inter type stack and compact card/table system
remain the design foundation. Content width is constrained for review work,
while overview and archive tables use the full available pane. Repeated cards
must represent concrete objects or actions, never abstract process steps.

## Time-series charts

Since 2026-08-18 the cockpit bundles Recharts for measured operational time
series. It renders locally with the cockpit's own token palette and no external
assets, inline scripts or remote styles. Unknown prices remain a separate
visible series; they are never drawn as zero cost.
