// The identities page's two rules: what the upsert body carries, and which of
// create-or-edit the dialog is actually about to do.
//
// A grant is the single authorization truth for a person, and the request that
// writes it is an UPSERT whose UPDATE keeps every field the body leaves out
// (src/http/routes.ts). Under that SQL an omitted key is not "unchanged by
// accident" — it is the console instructing the server to keep what it has. So
// every optional field the dialog can leave empty is a decision about whether
// emptiness means "not supplied" or "cleared", and getting it wrong makes the
// dialog close on a request that changed nothing while looking exactly like
// success.
//
// And the server decides create-vs-update by whether the row exists, which the
// console cannot read off its own buttons — so it reads it off the list it has
// already loaded.
import { describe, expect, test } from 'bun:test'
import {
  grantIntent,
  identityGrantBody,
  matchExistingGrant,
  type GrantDraft,
  type KnownGrant,
} from '../../../apps/cockpit/src/pages/identities.logic.ts'

const DRAFT: GrantDraft = {
  mode: 'role',
  role: 'reader',
  scopes: ['knowledge:read'],
  displayName: 'Alex Rivera',
  email: 'alex@example.com',
}

const ADMITTED: KnownGrant = { provider: 'entra', subject: 'sub-1', revoked_at: null }
const REVOKED: KnownGrant = { provider: 'entra', subject: 'sub-2', revoked_at: '2026-08-01T00:00:00.000Z' }

describe('the ceiling is stated exactly one way', () => {
  test('a preset sends role and never scopes — the server 422s on both', () => {
    const body = identityGrantBody(DRAFT, false)
    expect(body.role).toBe('reader')
    expect(body).not.toHaveProperty('scopes')
  })

  test('exact scopes send scopes and never role', () => {
    const body = identityGrantBody({ ...DRAFT, mode: 'scopes', scopes: ['knowledge:read', 'admin'] }, true)
    expect(body.scopes).toEqual(['knowledge:read', 'admin'])
    expect(body).not.toHaveProperty('role')
  })
})

describe('clearing the name on a prefilled form', () => {
  test('an emptied name is SENT as the empty string, not omitted', () => {
    // The bug this covers: omitting the key let the UPDATE's COALESCE keep the
    // stale placeholder, so the dialog closed with no error and no change.
    // `display_name` is `not null default ''` (migration 0028) and the schema
    // sets no minimum, so '' is a value the server stores.
    const body = identityGrantBody({ ...DRAFT, displayName: '   ' }, true)
    expect(body).toHaveProperty('display_name')
    expect(body.display_name).toBe('')
  })

  test('a name that is only being edited still arrives trimmed', () => {
    expect(identityGrantBody({ ...DRAFT, displayName: '  Alex Rivera  ' }, true).display_name).toBe('Alex Rivera')
  })
})

describe('a form that started blank', () => {
  test('an empty name is omitted — nothing was shown to clear', () => {
    // Deliberately asymmetric with the prefilled path: sending '' would claim
    // the operator supplied a name they never typed, and if the row turns out
    // to exist it would wipe a stored name they were never shown.
    const body = identityGrantBody({ ...DRAFT, displayName: '' }, false)
    expect(body).not.toHaveProperty('display_name')
  })

  test('a name that was typed is sent', () => {
    expect(identityGrantBody(DRAFT, false).display_name).toBe('Alex Rivera')
  })
})

describe('email', () => {
  test('an emptied email on a prefilled form is sent as null — the one way to clear it', () => {
    // The gap this closes: the column is nullable, '' is not NULL, and the
    // UPDATE used to COALESCE the value — so an operator removing a stale
    // address closed the dialog on a request that changed nothing, with no
    // error to tell them apart from success.
    const body = identityGrantBody({ ...DRAFT, email: '  ' }, true)
    expect(body).toHaveProperty('email')
    expect(body.email).toBeNull()
  })

  test('an empty email on a blank form is omitted, not nulled', () => {
    // Nothing was shown to clear. If the row exists after all, the omitted key
    // keeps the stored address rather than deleting one the operator never saw.
    expect(identityGrantBody({ ...DRAFT, email: '' }, false)).not.toHaveProperty('email')
  })

  test('a typed email is trimmed and never sent as the empty string', () => {
    expect(identityGrantBody({ ...DRAFT, email: ' alex@example.com ' }, true).email).toBe('alex@example.com')
    // '' is refused by zUpsertIdentityRequest on purpose (NULL is the column's
    // one empty), so the console must never produce it on either path.
    expect(identityGrantBody({ ...DRAFT, email: '   ' }, true).email).not.toBe('')
    expect(identityGrantBody({ ...DRAFT, email: '   ' }, false).email).toBeUndefined()
  })
})

describe('what the dialog is about to do', () => {
  test('a provider/subject nobody holds is a grant', () => {
    expect(matchExistingGrant([ADMITTED, REVOKED], 'entra', 'sub-new')).toBeNull()
    expect(grantIntent(false, null)).toBe('create')
  })

  test('typing an ADMITTED person into the grant dialog is an edit, not a grant', () => {
    // The defect: the console picked its wording from which button was pressed
    // and announced "Grant access" while the server took the UPDATE path —
    // replacing a scope ceiling somebody already had, which is the one case
    // where the wrong word is dangerous.
    expect(matchExistingGrant([ADMITTED, REVOKED], 'entra', 'sub-1')).toBe(ADMITTED)
    expect(grantIntent(false, ADMITTED)).toBe('edit')
  })

  test('a REVOKED person is neither — the server 409s and the list has the restore', () => {
    expect(grantIntent(false, REVOKED)).toBe('restore')
  })

  test('a row opened from the list is an edit whatever the list happens to hold', () => {
    expect(grantIntent(true, null)).toBe('edit')
  })

  test('matching trims, because the submit trims', () => {
    // A dialog that described ` sub-1 ` and addressed `sub-1` would promise one
    // thing and do another.
    expect(matchExistingGrant([ADMITTED], ' entra ', ' sub-1 ')).toBe(ADMITTED)
  })

  test('a half-typed identity matches nothing — provider and subject together ARE the row', () => {
    expect(matchExistingGrant([ADMITTED], 'entra', '')).toBeNull()
    expect(matchExistingGrant([ADMITTED], '', 'sub-1')).toBeNull()
    // Same subject under a different provider is a different person.
    expect(matchExistingGrant([ADMITTED], 'okta', 'sub-1')).toBeNull()
  })
})
