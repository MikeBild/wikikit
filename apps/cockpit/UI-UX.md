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

## Entscheidungs-Grammatik

Wortgleiche Kopie von §8 der Cockpit-Konvention v1.5 (`COCKPIT-KONVENTION.md` im Repo-Root). Sie steht hier, weil die Entscheidungs-Seite dieses Produkts an ihr gemessen wird; der Maßstab hat eine Quelle und keine abweichenden Kopien (§13). Eine einzige Abweichung, und sie ist sichtbar statt still: der Name des Schwester-Produkts, das die Referenz-Implementierung stellt, steht unter `apps/` nirgends — `test/unit/no-prod-references.test.ts` hält diese Fläche frei von Namen der übrigen Produkte. Der Wortlaut mit Namen steht im Repo-Root.

### 8. Entscheidungs-Grammatik

Jedes Produkt, das menschliche Entscheidungen sammelt (Freigaben, Reviews, Budget-Gates, Proposals), hat **eine** Entscheidungs-Seite. Sie beantwortet die drei Fragen in dieser Reihenfolge: Was passiert? Braucht es mich? Was tue ich dann? Die Referenz-Implementierung stellt ein Schwester-Produkt der Familie; jedes Produkt kopiert das Muster in eigene Komponenten (kein Import).

**8.1 Navigation.** Der Eintrag steht ungruppiert direkt unter der Übersicht und trägt einen Live-Zähler (offene Positionen, dedupliziert). Der Zähler kippt auf rot, sobald eine Position abgelaufen ist oder ein Health-Problem enthalten ist. Produktname des Eintrags einheitlich: „Entscheidungen".

**8.2 Queue.** Eine Spalte, max-w ~780 px. Default-Sortierung: ablaufend zuerst, dann älteste zuerst. Positionen älter als 3 Tage stehen in einer eigenen Rubrik „Liegt schon länger". Filter-Chips nach Art, Gruppieren-Umschalter (Keine / Art / Verursacher), Persistenz lokal.

**8.3 Zeile.** Meta-Zeile (Status-Glyph + Art-Badge · Quell-Referenz als Link · Frist „Entscheiden bis …" wo vorhanden, mit Herkunft) → Titel (line-clamp-2, nie UUID) → Wirkung in einer Zeile → Quellzeile. Aktionen rechts unten: Buttons benennen die Handlung („Freigeben", „Ablehnen", „Änderung anfordern" — nie „OK"). Ablehnung klappt ein Notizfeld in der Zeile auf. Entscheidung verlässt die Seite nie; Optimistic-Hide + Toast, Fehler bringt die Zeile zurück. ⋯-Menü: Später erinnern (Presets + eigener Zeitpunkt) · Dauerhaft verwerfen (mit Bestätigung; wenn endgültig, sagt die UI das) · Quelle öffnen.

**Drei Arten von Nein.** Wo das Produkt sie kennt, unterscheidet die Zeile: Ablehnung **mit** Begründung (schickt zurück ans Nacharbeiten) · Ablehnung **ohne** Begründung (beendet) · **Verwerfen** (folgenlos — als „folgenlos" beschriftet). Eine unbeantwortete Frist verfällt sichtbar als „verfallen (nicht entschieden)", nie stillschweigend. Ein wiederholter identischer Vorschlag zeigt die frühere Ablehnung samt Begründung — die Oberfläche bohrt nicht nach, bis der Mensch ja sagt. Wo Auftraggeber und Freigeber getrennte Rollen sind, zeigt die Zeile, wer entscheiden darf; die eigene Beauftragung ist markiert.

**8.4 Aufklappen.** Zeilen mit mehr Kontext tragen unten links einen benannten Toggle („Mehr anzeigen"), nie einen nackten Chevron. Aufgeklappt: volle Begründung, Rohdaten der Quelle, ggf. Formular für strukturierte Rückfragen. Die Entscheidungs-Buttons wandern ins Panel (kollabiert Kompakt-Form, expandiert Voll-Form).

**8.5 Regale.** Unter der aktiven Queue: einklappbare Sektionen „Zurückgestellt" (mit Wiedervorlage-Zeit), „Verworfen", „Entschieden" — gedimmt, mit Rückhol-Aktion wo die API es erlaubt. Grundsatz dahinter: **Zustand und Geschichte sind getrennte Flächen.** Die Queue zeigt nur den aktuellen Zustand (Erledigtes verschwindet, nichts wird durchgestrichen); die vollständige Geschichte wohnt im Audit/Aktivitätsprotokoll (append, nie gekürzt).

**8.6 Leere.** Nie etwas offen: grüner Check, „Alles erledigt" + „Gerade wartet keine Entscheidung auf dich." Nur weggefiltert: eigene, kompaktere Meldung mit Hinweis auf die Filter. Beide getrennt testbar (§4 gilt).

**8.7 Incident-Banner.** Die Übersicht zeigt oberhalb aller Kacheln einen nicht schließbaren roten Banner, sobald ein Budget-/Health-Gate offen oder eine Frist gerissen ist — mit konkreten Zahlen und Link auf die Entscheidungs-Seite. Ein Dashboard, das bei offenen Gates Ruhe meldet, ist ein Konventionsbruch.

**8.8 Produkt-Spezifisch bleibt:** die Arten (Kinds) und ihre Badges, die Resolver-Formulare, die Quell-Referenzen. Familienweit sind Struktur, Sprache, Sortierung, Regale, Leere-Zustände und der Banner-Vertrag.
