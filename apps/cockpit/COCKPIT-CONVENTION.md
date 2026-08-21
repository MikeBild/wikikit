# Cockpit convention

The yardstick for this cockpit is **[`COCKPIT-KONVENTION.md`](../../COCKPIT-KONVENTION.md) in the repo root**. Which version that is stands in its header line and nowhere else in the repo — `scripts/konvention-check.mjs` reads it from there and names it in every report. A number in this file would be a second source that can only go stale.

Until 2026-08-20 a second copy of the same fourteen paragraphs, rewritten for WikiKit, lived here. It is gone without replacement: §13 says the yardstick has one source and no copies, and two versions in one repo are exactly the situation in which a check can say which one it ran against without anybody knowing which one was meant.

The WikiKit-specific readings the copy carried additionally now live where they belong:

- **[`UI-UX.md`](UI-UX.md)** — how this cockpit implements the convention, including the wording of §8 the decisions page is measured against.
- **[`../../UEBERGABE.md`](../../UEBERGABE.md)** — the acceptance criteria this implementation is signed off against.
- **`scripts/konvention-check.mjs`** — the paragraphs checked against the rendered surface, with fixtures and without a database.

The root copy is the same file in all six products and is therefore not reformatted (see `.prettierignore`); changing it is an operation in six repos — deliberately expensive, so that it stays rare.
