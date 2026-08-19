# Cockpit-Konvention

Version 1.4 · 17.08.2026 · Gilt für: ContentKit, SubKit, WorkKit, WikiKit, CodeKit, WatchKit

**Modell: Konvention statt Bibliothek.** Jedes Produkt bleibt eigenständig — eigenes Repo, eigene shadcn-Komponenten (vendored, wie shadcn gedacht ist), eigene Releases, kein shared Package. Geteilt wird nur dieses Dokument. Eine Kopie liegt in jedem Repo; Abweichungen sind erlaubt, wo das Produkt es begründet — die Konvention ist der Default, nicht das Gesetz.

Referenz-Implementierung: der Zielbild-Prototyp (Artefakt „kit-cockpit-zielbilder"). Er zeigt jede Regel gerendert; bei Unklarheit gilt der Prototyp. Für §8 ist WorkKit die Referenz-Implementierung (Übergabe „workkit-entscheidungen-uebergabe"), für §9–§11 SubKit (Übergabe „subkit-referenzarchitektur-uebergabe").

Änderungen v1.1: neuer §8 Entscheidungs-Grammatik (hebt das Muster aus der WorkKit-Übergabe auf Familienebene); §1 Zone A verweist auf §8.
Änderungen v1.2: neue §9 Diff-Freigabe, §10 Sammlungs-Listen, §11 Verbindungs-Status (heben die Muster aus der SubKit-Übergabe auf Familienebene); §4 um „Leere führt zur Handlung" ergänzt.
Änderungen v1.3: §6 um kanonische Gruppennamen ergänzt; Umsetzungs-Vehikel für §§2–6 ist die Übergabe „shell-paket" (ein gleichförmiger Konformitäts-PR je Repo).
Änderungen v1.4: Endnutzer-Patterns aus den Produktivitäts-Leitfäden gehoben (Übergabe „endnutzer-pattern-adaption"): §5 Zusammenfassungszeile, §8.3 drei Arten von Nein, §8.5 Geschichte vs. Zustand, §11 Fähigkeits-Inventur, neu §12 Berichts-Grammatik, §13 Prüfen vor Reparieren, §14 Modus & Schranken.

---

## 1. Startscreen-Vertrag

Der erste Screen jedes Cockpits hat drei Zonen, in dieser Reihenfolge:

**Zone A — Wartet auf dich.** Alle menschlichen Gates des Produkts in einer Karte: Anzahl im Kopf, Alter der ältesten Position, eine Aktion pro Zeile. Amber ab 1. Der Zähler steht zusätzlich am Übersichts-Eintrag der Sidebar. Zone A ist die Kurzform der Entscheidungs-Seite (§8): sie zeigt die Top-Positionen derselben Queue und verlinkt dorthin; entschieden wird auf der Entscheidungs-Seite.

**Zone B — Kernobjekt-Hero.** Pro Produkt verschieden und dessen Identität: Release-Kette (ContentKit), Fehlergruppen (SubKit), Freigabe-Triage + Budgetampel (WorkKit), Fragen-Karten (WikiKit), Aufgaben je Projekt (CodeKit), ehrliches Banner + Streifen (WatchKit).

**Zone C — Zuletzt geschehen.** Letzte Läufe/Änderungen, jede Zeile klickbar.

Regeln: Kein Zähler ohne Link. Kein Rot ohne Weg zur Ursache. Betriebsmetriken (HTTP, p95, Calls) wohnen unter Installation → System, nie auf dem Startscreen. Nur WatchKit darf „nichts zu tun" als Erfolg inszenieren.

## 2. Zustandsvokabular

Sechs Zustände, jedes Produkt implementiert seine eigene Badge-Komponente mit denselben Namen und Farbrollen. Immer Punkt/Icon + Wort, nie Farbe allein.

| Zustand | Rolle | Licht (bg / fg) |
|---|---|---|
| Läuft | blau | #eff6ff / #1d4ed8 |
| Wartet auf dich | amber | #fffbeb / #b45309 |
| Erfolgreich | grün | #f0fdf4 / #15803d |
| Fehlgeschlagen | rot | #fef2f2 / #b91c1c |
| Abgebrochen | neutral | #f4f4f5 / #52525b |
| Entwurf | neutral, gestrichelter Rand | transparent / muted |

„Unbekannt" ist verboten: entweder wird der Zustand aufgelöst, oder es steht „nicht ermittelbar seit X" mit Grund. Statusfarben werden nie für Diagrammserien verwendet.

## 3. Lauf-Liste

Jede Liste von Ausführungen/Läufen zeigt mindestens: Name (sprechend, kein UUID-Prefix-Truncate) · Status-Badge · gestartet (relativ) · Dauer · Fortschritt n/m · Zeile klickbar. Fehlschläge tragen ihre Ursachengruppe in der Zeile („Ursache: Object not found") und sind nach Ursache gruppierbar — ein Eintrag je Ursache mit Zähler, nicht n identische Zeilen.

## 4. Drei Arten von Leere

Gemessene Null („0 · zuletzt geprüft vor 2 min") ≠ nicht erfasst (Hohlzelle, „Opt-in") ≠ noch nie benutzt (Leerzustand mit nächstem Schritt). Skeletons haben ein Timeout (5 s) und lösen in Leerzustand oder Fehlermeldung auf — nie dauerhaft.

**Leere führt zur Handlung.** Der „noch nie benutzt"-Zustand endet nie in einem leeren Formular: „Ersten Workflow anlegen" führt in den geführten Weg (Chat mit vorbereitetem Prompt, Assistent, Vorlage), ein leerer Chat zeigt Beispiel-Karten („Was kann diese Installation?") statt eines leeren Eingabefelds.

## 5. Sprache & Benennung

Deutsch auf oberster Ebene; Fachbegriffe (SRE, API-Namen) erst in der Detailtiefe. Rollen-Label einheitlich „Administrator". Destruktive Aktionen (Löschen, Verwerfen, Widerrufen) nie als rote Primärfläche in Listenzeilen — ins ⋯-Menü mit Bestätigung. Titel sind Zusammenfassungen, nie rohe Prompts oder UUIDs; Auto-Titel aus dem ersten Auftrag, wo kein Titel existiert.

**Zusammenfassungszeile.** Jedes benannte Objekt trägt eine 1–2-Satz-Zusammenfassung, und Listen zeigen sie unter dem Titel — einmal geschrieben (beim Anlegen, notfalls generiert), hundertmal gelesen. Der Lesepfad ist dreistufig: Landkarte (Bereichs-Start) → Zusammenfassungszeile → Volltext; Volltextsuche ist Fallback, nicht Haupteingang.

## 6. Struktur-Konstanten

Sidebar links: Wortmarke, gruppierte Navigation, Account unten (Avatar · E-Mail · Rolle · Menü: Profil/Sprache/Darstellung/Abmelden). Installation-Sektion enthält mindestens: System · Einstellungen · Zugangsdaten · Benachrichtigungen · Audit. Deep-Links funktionieren; unbekannte Routen zeigen eine gestaltete Seite mit Rückweg. Mandanten-Switcher trennt Prod/Test, Test ausblendbar.

**Kanonische Gruppennamen.** Geteilte Konzepte heißen in allen sechs Produkten gleich: die Admin-Gruppe heißt **„Installation"** (nie „Administration"), der Entscheidungs-Eintrag ist **ungruppiert** unter der Übersicht (§8.1), die Rolle heißt **„Administrator"** (eine Schreibweise, keine Versalien-Varianten). Produktspezifische Gruppen (Wiki, Überwachung, …) bleiben frei benannt — aber deutsch und in Normalschreibung.

## 7. Drift-Kontrolle ohne Shared Code

Die Konvention wird nicht technisch erzwungen. Zwei leichte Mechanismen statt dessen: (1) Diese Datei liegt versioniert in jedem Repo; eine Änderung an der Konvention ist ein PR in sechs Repos — bewusst teuer, damit sie selten ist. (2) Optional prüft WatchKit einzelne Regeln als Vertragsaussagen gegen die laufenden Cockpits (z. B. „kein ‚Unbekannt'-Status im DOM der Übersicht"), so wie es heute schon API-Zusagen gegen Verhalten prüft.

## 8. Entscheidungs-Grammatik

Jedes Produkt, das menschliche Entscheidungen sammelt (Freigaben, Reviews, Budget-Gates, Proposals), hat **eine** Entscheidungs-Seite. Sie beantwortet die drei Fragen in dieser Reihenfolge: Was passiert? Braucht es mich? Was tue ich dann? WorkKit ist die Referenz-Implementierung; jedes Produkt kopiert das Muster in eigene Komponenten (kein Import).

**8.1 Navigation.** Der Eintrag steht ungruppiert direkt unter der Übersicht und trägt einen Live-Zähler (offene Positionen, dedupliziert). Der Zähler kippt auf rot, sobald eine Position abgelaufen ist oder ein Health-Problem enthalten ist. Produktname des Eintrags einheitlich: „Entscheidungen".

**8.2 Queue.** Eine Spalte, max-w ~780 px. Default-Sortierung: ablaufend zuerst, dann älteste zuerst. Positionen älter als 3 Tage stehen in einer eigenen Rubrik „Liegt schon länger". Filter-Chips nach Art, Gruppieren-Umschalter (Keine / Art / Verursacher), Persistenz lokal.

**8.3 Zeile.** Meta-Zeile (Status-Glyph + Art-Badge · Quell-Referenz als Link · Frist „Entscheiden bis …" wo vorhanden, mit Herkunft) → Titel (line-clamp-2, nie UUID) → Wirkung in einer Zeile → Quellzeile. Aktionen rechts unten: Buttons benennen die Handlung („Freigeben", „Ablehnen", „Änderung anfordern" — nie „OK"). Ablehnung klappt ein Notizfeld in der Zeile auf. Entscheidung verlässt die Seite nie; Optimistic-Hide + Toast, Fehler bringt die Zeile zurück. ⋯-Menü: Später erinnern (Presets + eigener Zeitpunkt) · Dauerhaft verwerfen (mit Bestätigung; wenn endgültig, sagt die UI das) · Quelle öffnen.

**Drei Arten von Nein.** Wo das Produkt sie kennt, unterscheidet die Zeile: Ablehnung **mit** Begründung (schickt zurück ans Nacharbeiten) · Ablehnung **ohne** Begründung (beendet) · **Verwerfen** (folgenlos — als „folgenlos" beschriftet). Eine unbeantwortete Frist verfällt sichtbar als „verfallen (nicht entschieden)", nie stillschweigend. Ein wiederholter identischer Vorschlag zeigt die frühere Ablehnung samt Begründung — die Oberfläche bohrt nicht nach, bis der Mensch ja sagt. Wo Auftraggeber und Freigeber getrennte Rollen sind, zeigt die Zeile, wer entscheiden darf; die eigene Beauftragung ist markiert.

**8.4 Aufklappen.** Zeilen mit mehr Kontext tragen unten links einen benannten Toggle („Mehr anzeigen"), nie einen nackten Chevron. Aufgeklappt: volle Begründung, Rohdaten der Quelle, ggf. Formular für strukturierte Rückfragen. Die Entscheidungs-Buttons wandern ins Panel (kollabiert Kompakt-Form, expandiert Voll-Form).

**8.5 Regale.** Unter der aktiven Queue: einklappbare Sektionen „Zurückgestellt" (mit Wiedervorlage-Zeit), „Verworfen", „Entschieden" — gedimmt, mit Rückhol-Aktion wo die API es erlaubt. Grundsatz dahinter: **Zustand und Geschichte sind getrennte Flächen.** Die Queue zeigt nur den aktuellen Zustand (Erledigtes verschwindet, nichts wird durchgestrichen); die vollständige Geschichte wohnt im Audit/Aktivitätsprotokoll (append, nie gekürzt).

**8.6 Leere.** Nie etwas offen: grüner Check, „Alles erledigt" + „Gerade wartet keine Entscheidung auf dich." Nur weggefiltert: eigene, kompaktere Meldung mit Hinweis auf die Filter. Beide getrennt testbar (§4 gilt).

**8.7 Incident-Banner.** Die Übersicht zeigt oberhalb aller Kacheln einen nicht schließbaren roten Banner, sobald ein Budget-/Health-Gate offen oder eine Frist gerissen ist — mit konkreten Zahlen und Link auf die Entscheidungs-Seite. Ein Dashboard, das bei offenen Gates Ruhe meldet, ist ein Konventionsbruch.

**8.8 Produkt-Spezifisch bleibt:** die Arten (Kinds) und ihre Badges, die Resolver-Formulare, die Quell-Referenzen. Familienweit sind Struktur, Sprache, Sortierung, Regale, Leere-Zustände und der Banner-Vertrag.

## 9. Diff-Freigabe

Schlägt ein Agent oder Automat eine Änderung an einem verwalteten Objekt vor (Patch-Kandidat, Proposal, Revision, Preview-Promotion), gilt: **Die Entscheidung passiert, wo der Vorschlag entstand.**

**9.1 Diff-Karte.** Der Vorschlag erscheint als Karte in der Konversation bzw. auf der Quellseite: Ziel-Label (Objekt · Version, nie UUID) → Zeilen-Diff (alt/neu) → wo vorhanden das Prüf-Ergebnis daneben (Dry-Run, Preview, Lint) → Aktionen nach §8.3 („Freigeben", „Ablehnen", Notizfeld klappt auf). Kein Seitenwechsel für die Entscheidung.

**9.2 Doppelte Sichtbarkeit.** Jeder offene Vorschlag steht zusätzlich in der Entscheidungs-Queue (§8) — die Karte ist der schnelle Weg, die Queue das Sicherheitsnetz gegen Vergessen. Beide führen auf dieselbe API-Entscheidung, mit Audit-Spur.

**9.3 Produkt-Spezifisch bleibt:** der Diff-Renderer (Text, JSON, Code, Markdown), die Prüf-Semantik (Dry-Run vs. Preview vs. Build) und das Zielobjekt-Vokabular.

## 10. Sammlungs-Listen

Jede Sammlung gleichrangiger Objekte (Workflows, Skills, Quellen, Checks, Spaces) folgt einer Grammatik: Suche + Sortier-Header + **Kategorie-/Ordner-Chips** oberhalb der Liste („Alle" ist der einzige feste Chip; Kategorien kommen aus den Daten, nie hartkodiert). Umkategorisieren inline in der Zeile (Picker im ⋯-Bereich), nicht über eine Detailseite. Gefilterte Leere nennt den Filter und bietet den Rückweg („Alle anzeigen") — §4 gilt.

## 11. Verbindungs-Status

Alles, was eine Fremdsystem-Verbindung repräsentiert (Connector, Binding, Quelle, Site), zeigt sich als Karte oder Zeile mit drei Pflichtangaben: **Auth-Zustand** als Wort + Badge (verbunden · abgelaufen · Zugangsdaten fehlen · nie eingerichtet — Vokabular nach §2/§4), **Umgebung** (dev/prod-Badge, wo das Produkt Umgebungen kennt) und **„Verbindung testen"** als sichtbare Aktion mit Ergebnis in place. Ein abgelaufener OAuth-Zustand nennt den Weg zur Erneuerung — kein Rot ohne Weg zur Ursache (§1).

**Fähigkeits-Inventur.** Die Karte beantwortet die wichtigere Frage: **Was darf diese Verbindung?** Fähigkeitsliste (lesen · suchen · schreiben · …) plus Risikostufe als Badge (lesen · nach draußen · **schreibt**). Schreibrecht ist nie Kleingedrucktes — „ein Server, der schreiben darf, ohne dass du es weißt, ist keine Verbindung, sondern eine offene Tür." Ergänzend gehört zu jeder Installation eine **Rechte-Inventur**: angesammelte Einzelfreigaben, stehende Grants und Schlüssel mit Alter, letzter Nutzung und Widerruf in place — Rechte häufen sich still an, die Inventur macht es zur Entscheidung.

## 12. Berichts-Grammatik

Jeder automatisch erzeugte Bericht oder Digest endet mit einem Block „**Was du entscheiden musst**" — dessen Positionen sind dieselben wie in der Entscheidungs-Queue (§8) und verlinken dorthin. Ein Bericht ohne Befund ist kein leerer Lauf, sondern der Beleg, dass geprüft wurde: „0 Befunde · geprüft vor 2 min" (§4). Die **Reihe** der Berichte ist sichtbar — Lücken (ausgefallene Läufe) erscheinen als Lücke, nicht als Stille. Drei Nicht-Zustände bleiben unterscheidbar: geprüft-nichts-gefunden · nie hingeschaut · kein Zugang. Erfolgs-Aussagen verlinken ihren Beleg — eine Messung mit Herkunft, nie die Behauptung des Agenten; Assistenten-Antworten zitieren ihre Quellobjekte als Links.

## 13. Prüfen vor Reparieren

Wo ein Produkt automatisch pflegt, heilt oder aufräumt, sind Prüfen und Reparieren **zwei getrennte Aktionen in fester Reihenfolge**: „Prüfen" liest und ändert nichts (Ergebnis: Bericht nach §12); „Reparieren" folgt danach und nur in erlaubten Zonen. Ein Bearbeiter, der sein eigenes Ergebnis bewertet, meldet Erfolg — deshalb nie ein Knopf für beides. Sicherungen, familienweit: erst die Änderungsliste zeigen, dann ändern; ab einer Schwelle rückfragen; **Löschen ist immer ein Vorschlag, nie eine automatische Handlung**; bei Unsicherheit nicht anfassen; ein Befund ist kein Auftrag — der Mensch entscheidet pro Befund. Prüf-Ergebnisse nennen die Version des Maßstabs, gegen den sie liefen; der Maßstab hat eine Quelle und keine Kopien.

## 14. Modus & Schranken

Jeder Freigabe-/Autonomie-Modus zeigt am Wähler seine **Gate-Matrix**: welche Gates bleiben, welche entfallen — der Name allein sagt nichts über die Schranke, und zwei Modi mit gleicher Matrix sind eine Lesefalle. Regel- und Policy-Listen kennzeichnen jede Zeile als **Leitplanke** (Anweisungstext an das Modell — eine Bitte) oder **Grenze** (erzwungen durch Rechteprüfung, Abschottung oder nutzlastgebundene Freigabe). Wer beides gleich darstellt, verkauft Ordnung als Sicherheit.
