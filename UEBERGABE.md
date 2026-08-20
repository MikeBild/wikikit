# Übergabe: WikiKit Cockpit — der Wissenskreislauf als Nutzerführung

**Für:** Claude Code auf dem Mac, Repo `~/Projects/AI/wikikit`
**Referenz-Grundlage dieses Produkts:** Der Leitfaden
`~/Documents/Obsidian Vault/20-bereiche/knowledge-productivity/_index.md`
ist WikiKits Referenz für UI/UX und Nutzerführung. Er beschreibt den
Lebensweg einer Notiz in sechs Schritten (Einfangen · Einsortieren ·
Nachschlagen · Pflegen · Prüfen · Erinnern) — exakt WikiKits Domäne. Die
Cockpit-Aufgabe: **diese sechs Schritte werden die Erzählstruktur der
Oberfläche.** Familienregeln: Cockpit-Konvention v1.4; kein Shared Code.
Repo-Stand: `home/inbox/pages/changes/answers/care/decisions/search` u. a.
existieren; **kein `apps/cockpit/UI-UX.md`** — anlegen ist Schritt 0.

> **Fortschreibung 20.08.2026.** Der Absatz darüber ist der Stand bei der
> Übergabe und bleibt im Wortlaut stehen — er protokolliert, wogegen der Auftrag
> erteilt wurde, und das ist passiert. Seither: `apps/cockpit/UI-UX.md` ist
> angelegt, und die Konventions-Kopie im Repo-Root ist über v1.4 hinaus
> fortgeschrieben. Welche Fassung sie trägt, steht in ihrer Kopfzeile und wird
> von `scripts/konvention-check.mjs` von dort gelesen; diese Datei nennt die
> Nummer bewusst nicht noch einmal.

## Warum dieser Leitfaden die Referenz ist

WikiKits Startscreen ist bereits das IA-Vorbild der Familie (Fragen-Karten,
„die älteste wartet seit"). Der Leitfaden liefert das fehlende Stück: die
**Reihenfolge und Begründung**, in der ein Mensch mit Wissen arbeitet.
Jede Cockpit-Fläche bekommt ihren Platz in diesem Kreislauf — und die
Leerzustände erklären den jeweils nächsten Schritt im Kreislauf statt einer
Funktion.

## Stufe 1 — Die sechs Schritte auf die Flächen legen

**1 · Einfangen → Eingang.** Bleibt, wie es ist — bestes Capture-Konzept
der sechs Kits und Familien-Referenz für Konvention §4 („Leere führt zur
Handlung"). Regeln aus dem Leitfaden übernehmen: Capture ohne Pflichtfelder
und ohne Validierung (Einfangen kostet Sekunden, sonst unterbleibt es);
Dubletten sind erlaubt und billig — die Triage erkennt sie an der Quelle;
kein erzwungenes Umbenennen beim Einwurf (der Rohtitel ist ein Beleg).

**2 · Einsortieren → Triage.** „KI schlägt vor, du entscheidest" — die
Einsortier-Vorschläge (Ziel-Space, Titel, Zusammenfassung) erscheinen als
Entscheidungs-Positionen nach §8; „Nachfragen ist der Normalfall, kein
Mangel". Der Entscheidungsbaum des Leitfadens (fertig datierbar? dauerhaft?
nachschlagbar? sonst: liegen lassen **und melden**) wird die sichtbare
Logik der Vorschlagskarte.

**3 · Nachschlagen → der Lesepfad wird UI-Struktur (Konvention §5).**
Landkarte → Zusammenfassungszeile → Volltext: Space-Start ist eine
Landkarte mit Summaries, alle Listen (Seiten, Quellen, Antworten) zeigen
die Zusammenfassungszeile, Volltextsuche ist Fallback („sie findet Wörter,
keine Themen"). Antworten zitieren ihre Seiten — das tut WikiKit im Kern
schon (jede Aussage trägt ein Zitat); die UI stellt die Quellenangabe als
klickbaren, ersten Bestandteil der Antwort dar, nicht als Fußnote.

**4+5 · Pflegen & Prüfen → Care nach Konvention §13.** Zwei getrennte
Aktionen in fester Reihenfolge: „Prüfen (ändert nichts)" erzeugt einen
Bericht nach §12 (endet mit „Was du entscheiden musst" → §8-Queue);
„Reparieren" folgt danach. Die sechs Sicherungen des Leitfadens gelten
wörtlich: erst Liste zeigen, ab Schwelle fragen, **niemals löschen —
melden**, Umbenennen nur mit Link-Nachzug, bei Unsicherheit nicht
anfassen, nichts erfinden. Jeder Pflege-Befund trägt eine Aktion
(„verknüpfen", „löschen vorschlagen") — „ein Befund ist kein Auftrag",
der Mensch entscheidet pro Befund. Das deckt den 18-Warnungen-ohne-
Aktion-Befund. Prüf-Ergebnisse nennen die Leitlinien-Revision (§13:
der Maßstab hat keine Kopien).

**6 · Erinnern → Geschichte vs. Zustand (§8.5).** Änderungs-Historie und
Entscheidungs-Protokolle sind append-only (Geschichte); die
Offen-Flächen (Triage-Queue, Pflege-Befunde, wartende Proposals) zeigen
nur den Zustand — Erledigtes verschwindet, nichts wird durchgestrichen.

## Stufe 2 — Entscheidungen & Diff-Freigabe (§8/§9)

Queue-Quellen: Änderungs-Proposals · übernehmbare Antworten („Nicht
übernommen" → übernehmen/verwerfen) · Triage-Vorschläge · Pflege-Befunde.
Aging-Rubrik, Regale, Zero-States, Nav-Zähler nach §8 — die bestehende
`decisions.tsx` wird auf die §8-Anatomie gehoben, nicht neu gebaut.
Proposals erscheinen als **Diff-Karte** (§9): Konzeptseite alt/neu, Belege
daneben, entscheidbar in place. Die Review-Entscheidung bleibt human-owned
über die bestehende Elicitation-Mechanik — die Karte rendert sie, sie
umgeht sie nie. Ein abgelehntes Proposal wird bei identischer
Wiedereinreichung mit der früheren Ablehnung beantwortet (§8.3).

## Stufe 3 — Rohquellen-Schutz sichtbar machen

Die „eine Lücke, die weh tun kann" aus dem Leitfaden, als Garantie-Anzeige:
Archiv-Quellen tragen ein Badge **„Quelle unantastbar"** — verbatim
archiviert, Pflege-Läufe dürfen nur Metadaten. WikiKit archiviert bereits
verbatim (Inhalts-Hash existiert); die UI zeigt den Hash-Beleg als
Herkunftsnachweis (§12: Beleg statt Behauptung).

## Stufe 4 — Hygiene (aus der Begehung)

„Warnungen 18" und jede andere Zahl auf dem Start wird Link (§1: kein
Zähler ohne Link). Titelpflicht bei Ingest mit Fallback erste Überschrift;
Prompt-Titel kürzen (§5: Titel sind Zusammenfassungen); „Untitled
source"/„Seite ohne Titel" beheben. Wiki-Switcher: sortiert, Test-Probes
(`w7-read-scout`, `wikikit-e2e`, …) ausblendbar (§6). Claim und
Warnungstexte deutsch (§5). Rollen-Label „admin" → „Administrator"
(Shell-Paket S2).

## Akzeptanzkriterien (bindend, Format s. Übergaben-Index)

**AK-WI-1.1 · Kreislauf erkennbar**
Gegeben: jede Hauptfläche (Eingang/Seiten/Antworten/Pflege) im leeren Zustand.
Dann: der Leerzustand benennt den nächsten Schritt im Kreislauf mit
Handlung (nie nur „keine Einträge").
Prüfweg: E2E über alle vier Leerzustände + Visual.

**AK-WI-1.2 · Einwurf ohne Hürde**
Gegeben: der Eingang.
Wenn: „Etwas einwerfen" mit nur einem Text/Dokument.
Dann: Ablage ohne Pflichtfelder oder Validierung; Rohtitel bleibt erhalten;
eine bewusste Dublette wird angenommen (Triage erkennt sie später an der
Quelle).
Prüfweg: E2E.

**AK-WI-1.3 · Triage als Entscheidung**
Gegeben: 3 uneinsortierte Dokumente.
Wenn: die Triage-Position in `/decisions` geöffnet wird.
Dann: je Dokument Vorschlag für Ziel + Titel + Zusammenfassung;
„Übernehmen" führt alle Handgriffe aus; „Anpassen" erlaubt Korrektur;
unklare Fälle erscheinen als Rückfrage („liegen lassen und melden" ist ein
sichtbarer Ausgang).
Prüfweg: E2E.

**AK-WI-1.4 · Lesepfad (§5)**
Gegeben: ein Space mit 20 Seiten.
Dann: Space-Start ist Landkarte mit Summary-Zeilen; Seiten-/Quellen-/
Antworten-Listen zeigen die Zusammenfassungszeile unter dem Titel; eine
Antwort führt ihre zitierten Seiten als klickbare Quellen **vor** dem
Fließtext-Ende.
Prüfweg: E2E.

**AK-WI-1.5 · Prüfen ändert nichts (§13)**
Gegeben: ein Bestand mit bekannten Befunden.
Wenn: „Prüfen" läuft.
Dann: null schreibende API-Aufrufe während des Laufs; Ergebnis ist ein
Bericht, der mit „Was du entscheiden musst" endet und in die Queue
verlinkt; „Reparieren" ist ein separater Schritt danach.
Prüfweg: E2E (Netzwerk-Assert: keine Mutationen) + Unit.

**AK-WI-1.6 · Niemals löschen**
Gegeben: ein Duplikat-Befund.
Wenn: der Pflege-Lauf ihn behandelt.
Dann: es entsteht ein Lösch-**Vorschlag** als Entscheidungs-Position —
nie eine automatische Löschung; jeder der 18 Warnungs-Befunde trägt
mindestens eine Aktion.
Prüfweg: Unit + E2E.

**AK-WI-2.1 · Proposal-Diff-Karte (§9)**
Gegeben: ein offenes ChangeProposal.
Dann: Diff-Karte (Seite alt/neu) mit Verbatim-Belegen daneben; „Prüfung
öffnen" startet die bestehende Human-owned-Review-Mechanik — die Karte
liefert nie selbst die Entscheidung an die API.
Prüfweg: E2E + Code-Review-Assert (kein Decide-Call aus der Karte).

**AK-WI-2.2 · Ein Nein wird erinnert (§8.3)**
Gegeben: ein abgelehntes Proposal, identisch wieder eingereicht.
Dann: die neue Position zeigt die frühere Ablehnung samt Begründung.
Prüfweg: E2E (Fixture).

**AK-WI-3.1 · Quelle unantastbar**
Gegeben: eine archivierte Quelle.
Dann: Badge „Quelle unantastbar" mit Hash-Beleg; Pflege-Läufe können den
Volltext nicht verändern (nur Metadaten), und die UI sagt das.
Prüfweg: E2E + API-Assert.

**AK-WI-4.1 · Hygiene**
Dann: jede Zahl auf dem Start ist Link (§1); Wiki-Switcher sortiert mit
ausblendbaren Test-Probes; Ingest erzwingt Titel (Fallback erste
Überschrift); keine „Untitled source"/„Seite ohne Titel" mehr erzeugbar;
Claim + Warnungstexte deutsch.
Prüfweg: E2E + Visual.

**AK-WI-G.1 · Gates**
Dann: `UI-UX.md` angelegt; eine Konventions-Kopie liegt im Repo-Root und ist
die unveränderte Familienfassung — **welche** es ist, sagt ihre eigene
Kopfzeile, und `scripts/konvention-check.mjs` liest die Fassung von dort und
nennt sie in seinem Bericht; Rollen-Label „Administrator"; alle Repo-Gates grün.
Prüfweg: CI-Gate.

> Das Kriterium trug bis 20.08.2026 eine Versionsnummer im Text („Kopie v1.4",
> dann „v1.5"). Eine Nummer im Kriterium ist von einer veralteten Kopie erfüllbar
> und muss jeder Runde hinterherlaufen; gefordert ist Identität mit der
> Familienquelle, nicht eine Zahl. Die Zahl steht jetzt an genau einer Stelle im
> Repo — in der Kopfzeile der Kopie —, und der Check behauptet sie nicht mehr,
> sondern liest sie.
