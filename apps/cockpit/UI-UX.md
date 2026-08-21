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

## Decision grammar

Verbatim copy of §8 of the cockpit convention (`COCKPIT-KONVENTION.md` in the repo root; its header line says which version). It stands here because this product's decisions page is measured against it; the yardstick has one source and no diverging copies (§13). One single deviation, and it is visible rather than silent: no sibling product is named under `apps/` — `test/unit/no-prod-references.test.ts` keeps this surface free of the other products' names. It touches two places: the sentence naming the reference implementation in §8, and the measurements in §8.5b, where the family text attributes a queue size to each of three products. Both keep the rule and drop the names. The wording with names is in the repo root.

The quoted paragraphs below stay in German: they are the family text verbatim, and the cockpit's surface is German by §5.

### 8. Entscheidungs-Grammatik

Jedes Produkt, das menschliche Entscheidungen sammelt (Freigaben, Reviews, Budget-Gates, Proposals), hat **eine** Entscheidungs-Seite. Sie beantwortet die drei Fragen in dieser Reihenfolge: Was passiert? Braucht es mich? Was tue ich dann? Die Referenz-Implementierung stellt ein Schwester-Produkt der Familie; jedes Produkt kopiert das Muster in eigene Komponenten (kein Import).

**8.1 Navigation.** Der Eintrag steht ungruppiert direkt unter der Übersicht und trägt einen Live-Zähler (offene Positionen, dedupliziert). Der Zähler kippt auf rot, sobald eine Position abgelaufen ist oder ein Health-Problem enthalten ist. Produktname des Eintrags einheitlich: „Entscheidungen".

**8.2 Queue.** Eine Spalte, max-w ~780 px. Default-Sortierung: ablaufend zuerst, dann älteste zuerst. Positionen älter als 3 Tage stehen in einer eigenen Rubrik „Liegt schon länger". Filter-Chips nach Art, Gruppieren-Umschalter (Keine / Art / Verursacher), Persistenz lokal.

**8.3 Zeile.** Meta-Zeile (Status-Glyph + Art-Badge · Quell-Referenz als Link · Frist „Entscheiden bis …" wo vorhanden, mit Herkunft) → Titel (line-clamp-2, nie UUID) → Wirkung in einer Zeile → Quellzeile. Aktionen rechts unten: Buttons benennen die Handlung („Freigeben", „Ablehnen", „Änderung anfordern" — nie „OK"). Ablehnung klappt ein Notizfeld in der Zeile auf. Entscheidung verlässt die Seite nie; Optimistic-Hide + Toast, Fehler bringt die Zeile zurück. ⋯-Menü: Später erinnern (Presets + eigener Zeitpunkt) · Dauerhaft verwerfen (mit Bestätigung; wenn endgültig, sagt die UI das) · Quelle öffnen.

**Drei Arten von Nein.** Wo das Produkt sie kennt, unterscheidet die Zeile: Ablehnung **mit** Begründung (schickt zurück ans Nacharbeiten) · Ablehnung **ohne** Begründung (beendet) · **Verwerfen** (folgenlos — als „folgenlos" beschriftet). Eine unbeantwortete Frist verfällt sichtbar als „verfallen (nicht entschieden)", nie stillschweigend. Ein wiederholter identischer Vorschlag zeigt die frühere Ablehnung samt Begründung — die Oberfläche bohrt nicht nach, bis der Mensch ja sagt. Wo Auftraggeber und Freigeber getrennte Rollen sind, zeigt die Zeile, wer entscheiden darf; die eigene Beauftragung ist markiert.

**8.4 Aufklappen.** Zeilen mit mehr Kontext tragen unten links einen benannten Toggle („Mehr anzeigen"), nie einen nackten Chevron. Aufgeklappt: volle Begründung, Rohdaten der Quelle, ggf. Formular für strukturierte Rückfragen. Die Entscheidungs-Buttons wandern ins Panel (kollabiert Kompakt-Form, expandiert Voll-Form).

**8.5 Zustand und Geschichte sind getrennte Flächen.** Die Entscheidungs-Seite zeigt ausschließlich, was auf den Menschen wartet. Zurückgestellt, Verworfen und Entschieden sind Vergangenheit: Erledigtes verlässt die Queue — es wird nicht gedimmt, nicht durchgestrichen, nicht in eigene Sektionen unter der Queue gestellt und nicht über Zustands-Chips wieder hereingeholt. Ein Umschalter, der die Queue auf einen vergangenen Zustand stellt, ist ein Konventionsbruch; Filter auf der Queue filtern die **Art**, nie den Zustand. Die vollständige Geschichte wohnt im Audit-/Aktivitätsprotokoll (append, nie gekürzt) und ist von der Entscheidungs-Seite über **genau einen** Verweis erreichbar — ein Satz mit Link, keine Zähler-Kacheln. Wo die Vergangenheit dort nur als Maschinenwert ankommt, gehören Benennung und Filter ins Protokoll, nicht die Sektionen zurück in die Queue.

**8.5a Zähler-Kacheln.** Für **Offenes** erwünscht — wenn sie Entscheidungen nach **Kategorie**
aufschlüsseln und dadurch Übersicht schaffen, statt eine Summe zu wiederholen. Jede Kachel führt
auf die gefilterte Liste. Für **Erledigtes** gibt es keine. _(Mike, 21.08.2026.)_

**8.5b Die Zahl selbst ist eine Design-Frage.** Eine Entscheidungs-Seite, die einem Menschen
Hunderte Positionen vorlegt, hat ihre Aufgabe verfehlt, egal wie gut sie gegliedert ist.
Gemessen am 21.08.2026 an den Schwester-Produkten: eines legt **359 Positionen** vor, weil Doku-
und Drift-Befunde als Entscheidungen zählen; ein zweites zeigt **15 gleichartige Budget-Sperren
einzeln**; ein drittes lässt **jede Korrektur-Karte einer Gruppe einzeln** entscheiden, und bei
ihm trugen die wartenden Unterhaltungen **weder Freigeben noch Ablehnen** — folgenlose
Positionen in einer Entscheidungs-Queue.

Das ist kein Darstellungs-, sondern ein Zuschnittsproblem:
**was gleichartig ist, wird zu einer Entscheidung zusammengefasst; was folgenlos ist, ist keine.**

> **Korrektur, 21.08. 18:40.** Oben stand, bei jenem dritten Produkt seien **32 von 35**
> Positionen wartende Unterhaltungen. Die 32 stammen aus dem **Prüfstand-Mock**, der den
> Statusfilter ignorierte; auf PROD liefert derselbe Aufruf `total=1`. Gefunden vom Verifier
> jenes Produkts, nachdem der Satz bereits byte-gleich in sechs Repos stand. **Eine Zahl, die
> niemand nachmisst, wird durch Verteilung nicht wahrer.**
>
> **Zweite Korrektur, 21.08. 19:20.** Der erste Korrekturblock stand _vor_ dem Regelsatz, und
> Markdowns lazy continuation zog ihn mit hinein — die Regel las sich in allen sechs Repos als
> Teil einer historischen Fußnote. Gefunden vom Verifier der Konventionsrunde, der die Datei
> durch einen Markdown-Renderer geschickt hat statt sie zu lesen. **Auch eine Korrektur kann
> beschädigen, was sie korrigiert.**

**8.6 Leere.** Nie etwas offen: grüner Check, „Alles erledigt" + „Gerade wartet keine Entscheidung auf dich." Nur weggefiltert: eigene, kompaktere Meldung mit Hinweis auf die Filter. Beide getrennt testbar (§4 gilt).

**8.7 Incident-Banner.** Die Übersicht zeigt oberhalb aller Kacheln einen nicht schließbaren roten Banner, sobald ein Budget-/Health-Gate offen oder eine Frist gerissen ist — mit konkreten Zahlen und Link auf die Entscheidungs-Seite. Ein Dashboard, das bei offenen Gates Ruhe meldet, ist ein Konventionsbruch.

**8.8 Produkt-Spezifisch bleibt:** die Arten (Kinds) und ihre Badges, die Resolver-Formulare, die Quell-Referenzen. Familienweit sind Struktur, Sprache, Sortierung, die Trennung von Zustand und Geschichte, Leere-Zustände und der Banner-Vertrag.
