import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUDIT_ACTOR_KINDS, AUDIT_RESULTS } from '../../../src/domain/audit.ts'
import {
  AUDIT_ACTOR_KEYS,
  AUDIT_KIND_KEYS,
  AUDIT_OPERATION_KEYS,
  AUDIT_RESULT_KEYS,
} from '../../../apps/cockpit/src/lib/audit-vocabulary.ts'
import { CATALOGS, type TranslationKey } from '../../../apps/cockpit/src/lib/i18n.ts'

const root = join(import.meta.dir, '../../..')
const page = readFileSync(join(root, 'apps/cockpit/src/pages/audit.tsx'), 'utf8')

/**
 * A GUARD OVER THE VOCABULARY — the one this repository did not have.
 *
 * The audit page's words used to be checked against the page's own tables, and
 * a reading derived from the thing it checks can only ever agree with itself. A
 * derived list also SHRINKS SILENTLY: fewer entries is fewer things checked,
 * which looks exactly like fewer things wrong.
 *
 * So the two readings here are independent on purpose. The Cockpit's labels are
 * WRITTEN DOWN in `lib/audit-vocabulary.ts`; the actions are READ OUT of the
 * one writer in `src/http/routes.ts`. Neither can move without the other, and a
 * rename on either side is red, by name.
 *
 * scripts/konvention-check.mjs reads the painted table and can only ever see
 * what the fixture put in front of it. This reads the whole vocabulary, and the
 * two together are what make §15.2 an assertion rather than a description.
 */

/**
 * Every action string this installation can write into the chain.
 *
 * TWO WRITERS, AND THE SECOND ONE IS WHY THIS FUNCTION HAS A SECOND HALF.
 *
 * `auditedReview` in src/http/routes.ts names its action as a literal on an
 * `action:` property; reading the property rather than the file keeps another
 * TypeScript writer from slipping past this on the day somebody adds one.
 *
 * Migration 0046 seeds the marker the chain opens with, in SQL, and no reading
 * of `src/**\/*.ts` can see it. It was missing from the Cockpit's vocabulary
 * for exactly that reason, and this test was green: the first run against a
 * real installation put `audit.trail.opened` in front of a reader as a machine
 * value. A derivation that cannot see a writer does not report a gap — it
 * reports nothing, which is the failure this file exists to prevent.
 */
function actionsTheServerWrites(): Set<string> {
  const actions = new Set<string>()
  const routes = readFileSync(join(root, 'src/http/routes.ts'), 'utf8')
  for (const line of routes.split('\n')) {
    if (!/^\s*action:/.test(line)) continue
    for (const match of line.matchAll(/'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g)) actions.add(match[1]!)
  }
  const migration = readFileSync(join(root, 'src/db/migrations/0046_wk_audit_trail.sql'), 'utf8')
  for (const match of migration.matchAll(/'(audit\.trail(?:\.[a-z_]+)+)'/g)) actions.add(match[1]!)
  return actions
}

describe('the audit trail is read in words the server actually writes — §15.2', () => {
  test('the derivation reaches both writers', () => {
    // A guard on the guard. Every assertion below loops over this set, so a
    // derivation that silently found nothing would pass every one of them —
    // which is the exact shape of the failure this file exists for.
    const actions = actionsTheServerWrites()
    expect(actions.has('proposal.approved')).toBe(true)
    expect(actions.has('audit.trail.opened')).toBe(true)
    expect(actions.size).toBeGreaterThanOrEqual(5)
  })

  test('every action the server writes has a German name', () => {
    const unnamed = [...actionsTheServerWrites()].filter((action) => !(action in AUDIT_OPERATION_KEYS)).sort()
    expect(unnamed).toEqual([])
  })

  test('no name stands for an action nothing writes any more', () => {
    const written = actionsTheServerWrites()
    expect(
      Object.keys(AUDIT_OPERATION_KEYS)
        .filter((action) => !written.has(action))
        .sort(),
    ).toEqual([])
  })

  /**
   * The closed enums the chain stores, held against the words that read them.
   *
   * `AUDIT_RESULTS` and `AUDIT_ACTOR_KINDS` are the database's own CHECK
   * constraints, exported. A fifth result added there and not here is a value
   * that reaches an operator raw — the defect §15.2 names for „Vorgang", and it
   * means just as much for „Ergebnis".
   */
  test('every stored result and actor kind is named', () => {
    expect(AUDIT_RESULTS.filter((value) => !(value in AUDIT_RESULT_KEYS))).toEqual([])
    expect(AUDIT_ACTOR_KINDS.filter((value) => !(value in AUDIT_ACTOR_KEYS))).toEqual([])
  })

  test('every name resolves in both catalogs', () => {
    const names: TranslationKey[] = [
      ...Object.values(AUDIT_OPERATION_KEYS),
      ...Object.values(AUDIT_KIND_KEYS),
      ...Object.values(AUDIT_RESULT_KEYS),
      ...Object.values(AUDIT_ACTOR_KEYS),
      // The five column names §15.2 legislates, in the order it legislates them.
      'audit.column.when',
      'audit.column.subject',
      'audit.column.kind',
      'audit.column.outcome',
      'audit.column.actor',
      'page.audit.title',
    ]
    const missing: string[] = []
    for (const locale of ['en', 'de'] as const) {
      for (const key of names) {
        const value = CATALOGS[locale][key]
        if (!value || value.trim() === '') missing.push(`${locale}: ${key}`)
      }
    }
    expect(missing.sort()).toEqual([])
  })

  /**
   * §15.1 and §15.2 name their words. This is where the words themselves are
   * pinned — the browser probe reads them off the PAINTED table, and a
   * paragraph only one of the two enforces is one refactor away from prose.
   */
  test('the heading and the five column names are the ones §15 writes', () => {
    expect(CATALOGS.de['page.audit.title']).toBe('Audit-Trail')
    expect(CATALOGS.de['nav.audit']).toBe('Audit')
    expect([
      CATALOGS.de['audit.column.when'],
      CATALOGS.de['audit.column.subject'],
      CATALOGS.de['audit.column.kind'],
      CATALOGS.de['audit.column.outcome'],
      CATALOGS.de['audit.column.actor'],
    ]).toEqual(['Zeitpunkt', 'Vorgang', 'Art', 'Ergebnis', 'Verursacher'])
  })
})

describe('the page reads the trail rather than rebuilding it — §15.5', () => {
  /**
   * The registered defect, as a test.
   *
   * WK-AUDIT-SEITE-LIEST-VIER-HISTORIEN: this page merged proposals, ingests,
   * concepts and charter versions into something shaped like an audit trail
   * while `GET /v1/audit` sat unused beside it. The browser probe measures the
   * requests that actually go out; this holds the source, so the two disagree
   * loudly if either is edited alone.
   */
  test('it calls wk.audit and nothing else', () => {
    expect(page).toContain('wk.audit.list(query)')
    for (const rebuilt of ['wk.proposals.list', 'wk.ingest.list', 'wk.concepts.list', 'wk.charter.versions']) {
      expect(page, `${rebuilt} is a foreign history, not the trail`).not.toContain(rebuilt)
    }
    expect(page, 'Promise.allSettled over several records is the merge this page stopped being').not.toContain(
      'Promise.allSettled',
    )
  })

  /**
   * §15.3 — the hashes are on the page, and §15.2 — the instant is absolute.
   *
   * Source assertions, because both are about what the page CAN show rather
   * than about what a fixture happened to contain.
   */
  test('the row detail shows the chain, and the timestamp is an instant', () => {
    expect(page).toContain('event.prev_sha256')
    expect(page).toContain('event.sha256')
    expect(page).toContain('dateTime(event.occurred_at)')
    expect(page, 'a span cannot be cited, and its German puts a preposition on the quantity').not.toContain(
      'RelativeTime',
    )
    expect(page).not.toContain('relative-time')
  })

  /** §15.4 — the page says what the chain does not hold. */
  test('the page says what it is not', () => {
    expect(page).toContain('data-testid="audit-footnote"')
    expect(page).toContain("t('audit.footnote')")
    for (const locale of ['en', 'de'] as const) {
      expect(CATALOGS[locale]['audit.footnote'].length).toBeGreaterThan(80)
    }
  })
})
