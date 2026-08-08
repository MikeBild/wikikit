// The identities page's one rule: what the upsert body carries.
//
// A grant is the single authorization truth for a person, and the request that
// writes it is an UPSERT whose UPDATE reads `display_name = COALESCE($4,
// display_name)` (src/http/routes.ts). Under that SQL an omitted key is not
// "unchanged by accident" — it is the console instructing the server to keep
// what it has. So every optional field the dialog can leave empty is a decision
// about whether emptiness means "not supplied" or "cleared", and getting it
// wrong makes the dialog close on a request that changed nothing while looking
// exactly like success.
import { describe, expect, test } from 'bun:test'
import { identityGrantBody, type GrantDraft } from '../../../apps/cockpit/src/pages/identities.logic.ts'

const DRAFT: GrantDraft = {
  mode: 'role',
  role: 'reader',
  scopes: ['knowledge:read'],
  displayName: 'Alex Rivera',
  email: 'alex@example.com',
}

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

describe('clearing the name on an existing grant', () => {
  test('an emptied name is SENT as the empty string, not omitted', () => {
    // The bug this covers: omitting the key let `COALESCE($4, display_name)`
    // keep the stale placeholder, so the dialog closed with no error and no
    // change. `display_name` is `not null default ''` (migration 0028) and the
    // schema sets no minimum, so '' is a value the server stores.
    const body = identityGrantBody({ ...DRAFT, displayName: '   ' }, true)
    expect(body).toHaveProperty('display_name')
    expect(body.display_name).toBe('')
  })

  test('a name that is only being edited still arrives trimmed', () => {
    expect(identityGrantBody({ ...DRAFT, displayName: '  Alex Rivera  ' }, true).display_name).toBe('Alex Rivera')
  })
})

describe('creating a grant', () => {
  test('an empty name is omitted — the INSERT writes the same empty default', () => {
    // Deliberately asymmetric with the edit path: there is nothing to clear on
    // a row that does not exist, and sending '' would claim the operator
    // supplied a name they never typed.
    const body = identityGrantBody({ ...DRAFT, displayName: '' }, false)
    expect(body).not.toHaveProperty('display_name')
  })

  test('a name that was typed is sent', () => {
    expect(identityGrantBody(DRAFT, false).display_name).toBe('Alex Rivera')
  })
})

describe('email', () => {
  test('an empty email is omitted on both paths', () => {
    // NOT the same decision as display_name, and not an oversight: the column
    // is nullable, '' is not NULL, and the wire type has no way to say "clear
    // it". Sending '' would put a second kind of empty into a nullable column.
    expect(identityGrantBody({ ...DRAFT, email: '  ' }, true)).not.toHaveProperty('email')
    expect(identityGrantBody({ ...DRAFT, email: '' }, false)).not.toHaveProperty('email')
  })

  test('a typed email is trimmed', () => {
    expect(identityGrantBody({ ...DRAFT, email: ' alex@example.com ' }, true).email).toBe('alex@example.com')
  })
})
