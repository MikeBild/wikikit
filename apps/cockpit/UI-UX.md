# WikiKit Cockpit UI/UX

The Cockpit teaches one knowledge lifecycle. It must not expose a parallel
workflow, compatibility route, or hidden shortcut around human review.

## Lifecycle

1. **Capture — What arrived?** Every file, URL and pasted text is parked in the
   Inbox before processing.
2. **Triage — Where does it belong?** The system may suggest a wiki, title and
   summary. A person edits and resolves the suggestion.
3. **Retrieve — What do we already know?** Search and answers prefer reviewed
   knowledge and label source-only evidence distinctly.
4. **Care — What needs repair?** Care reports concrete findings and links to
   their repair surface.
5. **Check — Is it grounded and safe?** Checks are explicit and read-only.
   Their timestamp and guideline revision stay visible.
6. **Remember — What did people decide?** The decision log records settled
   choices separately from the active attention queue.

## Navigation and routes

- `/decisions` is the single attention queue for proposals, triage, outputs and
  care findings.
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
remain the design foundation. The numbered six-step lifecycle is the Cockpit's
signature visual. Content width is constrained for review work, while archive
tables use the full available pane.
