# WikiKit Cockpit UI/UX

The Cockpit follows the questions an end user actually has. It must not expose
internal pipeline stages as navigation, a compatibility route, or a hidden
shortcut around human review.

## End-user model

- **Start — Where is work waiting?** The cross-wiki overview comes first, then
  the selected wiki's search, open decisions and published pages.
- **Wikis — Which knowledge areas exist?** Wikis are a primary destination;
  production wikis lead and test wikis are hidden until requested.
- **Inbox — What arrived?** Files, URLs and pasted text wait here until their
  destination is clear.
- **Pages and Search — What do we know?** Published knowledge and archived-only
  evidence are visibly different.
- **Decisions — What needs a human choice?** Only proposals, inbox triage and
  unfiled generated results belong here. Every item names its origin and target.
- **Check — What did the read-only inspection observe?** Informational findings
  and actionable repairs are separate and each action explains its effect.
- **Sources and decision log — Where did this come from?** Immutable evidence,
  its current uses and settled choices remain traceable.

## Navigation and routes

- `/` leads with all visible production wikis and then the selected wiki.
- `/spaces` is the complete wiki list and is not installation-only navigation.
- `/decisions` is the single attention queue for proposals, triage and outputs.
- `/care` contains check observations; findings are not decisions.
- `/decisions/proposals/:id` is the full proposal review surface.
- `/decision-log` contains recorded decisions.
- Removed routes are intentionally not redirected. The not-found page returns
  people to current navigation.

## Interaction rules

- Critical effects, rejection history, citations and source-lock state are
  visible without a tooltip.
- Source bytes are immutable. Corrections enter as new captured material.
- Generated output can enter knowledge only through ordinary ingest and human
  proposal review.
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
