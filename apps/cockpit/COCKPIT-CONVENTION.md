# Cockpit-Konvention

Der Maßstab für dieses Cockpit ist **[`COCKPIT-KONVENTION.md`](../../COCKPIT-KONVENTION.md) im Repo-Root**, Version 1.4.

Hier lag bis 20.08.2026 eine zweite, für WikiKit umgeschriebene Fassung derselben vierzehn Paragrafen. Sie ist ersatzlos entfallen: §13 sagt, der Maßstab hat eine Quelle und keine Kopien — und zwei Fassungen im selben Repo sind genau die Lage, in der eine Prüfung sagen kann, gegen welche sie lief, ohne dass jemand weiß, welche gemeint war. Eine geänderte Regel hätte an zwei Stellen nachgezogen werden müssen; die zweite wäre die gewesen, die es nicht wird.

Was die Kopie zusätzlich enthielt, waren WikiKit-Auslegungen einzelner Absätze. Die stehen jetzt dort, wo sie hingehören:

- **[`UI-UX.md`](UI-UX.md)** — wie dieses Cockpit die Konvention umsetzt, inklusive des Wortlauts von §8, an dem die Entscheidungs-Seite gemessen wird.
- **[`../../UEBERGABE.md`](../../UEBERGABE.md)** — die Akzeptanzkriterien, gegen die diese Umsetzung abgenommen wird.
- **`scripts/konvention-check.mjs`** — die Paragrafen, die gegen die gerenderte Oberfläche geprüft werden, mit Fixtures und ohne Datenbank.

Die Root-Kopie ist in allen sechs Produkten dieselbe Datei und wird deshalb nicht umformatiert (siehe `.prettierignore`); eine Änderung an ihr ist ein Vorgang in sechs Repos — bewusst teuer, damit sie selten ist.
