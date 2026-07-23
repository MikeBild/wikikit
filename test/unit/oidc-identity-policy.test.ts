import { describe, expect, test } from 'bun:test'
import type { OidcProviderConfig } from '../../src/config.ts'
import {
  isOidcIdentityAllowed,
  OIDC_SIGNUP_SCOPES,
  oidcIdentityFromClaims,
  oidcIdentityScopeCeiling,
} from '../../src/oauth/identity-policy.ts'

const provider: OidcProviderConfig = {
  protocol: 'oidc',
  id: 'workforce',
  label: 'Workforce',
  issuer: 'https://identity.example.test',
  clientId: 'wikikit',
  scopes: 'openid email profile',
  allowedEmails: ['reviewer@example.test'],
  allowedSubjects: ['subject-without-email'],
  allowedScopes: ['knowledge:read'],
}

describe('OIDC identity policy', () => {
  test('accepts an explicitly allowed subject without email claims', () => {
    expect(oidcIdentityFromClaims(provider, { sub: 'subject-without-email' })).toEqual({
      subject: 'subject-without-email',
      email: null,
    })
  })

  test('uses email only when the provider marks it verified', () => {
    expect(
      oidcIdentityFromClaims(provider, {
        sub: 'different-subject',
        email: ' Reviewer@Example.Test ',
        email_verified: true,
      }),
    ).toEqual({ subject: 'different-subject', email: 'reviewer@example.test' })
    expect(isOidcIdentityAllowed(provider, 'different-subject', null)).toBe(false)
  })

  test('rejects an unknown subject when email is absent or unverified', () => {
    expect(() =>
      oidcIdentityFromClaims(provider, {
        sub: 'different-subject',
        email: 'reviewer@example.test',
        email_verified: false,
      }),
    ).toThrow(/not allowed/)
  })

  test('allowUnknown returns the unknown identity instead of rejecting it (signup branch)', () => {
    expect(
      oidcIdentityFromClaims(
        provider,
        { sub: 'unknown-subject', email: 'stranger@example.test', email_verified: true },
        { allowUnknown: true },
      ),
    ).toEqual({ subject: 'unknown-subject', email: 'stranger@example.test' })
    // A missing sub stays fatal even with allowUnknown.
    expect(() => oidcIdentityFromClaims(provider, { email: 'x@example.test' }, { allowUnknown: true })).toThrow(
      /must contain sub/,
    )
  })
})

describe('per-identity scope ceiling (the grant row is the single AuthZ truth)', () => {
  test('an unregistered identity has no ceiling', () => {
    expect(oidcIdentityScopeCeiling(provider, 'anyone', undefined)).toBeNull()
  })

  test('a pre-0028 bootstrap row without a mirrored ceiling inherits the provider allowed_scopes while allowlisted', () => {
    expect(
      oidcIdentityScopeCeiling(provider, 'subject-without-email', {
        email: null,
        allowed_scopes: null,
        grant_source: 'bootstrap',
      }),
    ).toEqual(provider.allowedScopes)
    expect(
      oidcIdentityScopeCeiling(provider, 'other', {
        email: 'Reviewer@Example.Test',
        allowed_scopes: null,
        grant_source: 'bootstrap',
      }),
    ).toEqual(provider.allowedScopes)
  })

  test('an operator-managed grant beats the allowlist: the stored ceiling wins even for allowlisted subjects', () => {
    expect(
      oidcIdentityScopeCeiling(provider, 'subject-without-email', {
        email: null,
        allowed_scopes: ['knowledge:read', 'knowledge:propose', 'knowledge:review'],
        grant_source: 'admin',
      }),
    ).toEqual(['knowledge:read', 'knowledge:propose', 'knowledge:review'])
    expect(
      oidcIdentityScopeCeiling(provider, 'seeded-subject', {
        email: null,
        allowed_scopes: ['knowledge:read'],
        grant_source: 'seed',
      }),
    ).toEqual(['knowledge:read'])
  })

  test('a mirrored bootstrap row is admitted through its stored ceiling', () => {
    expect(
      oidcIdentityScopeCeiling(provider, 'subject-without-email', {
        email: null,
        allowed_scopes: ['knowledge:read'],
        grant_source: 'bootstrap',
      }),
    ).toEqual(['knowledge:read'])
  })

  test('a signup identity is admitted through its own stored minimal ceiling', () => {
    expect(
      oidcIdentityScopeCeiling(provider, 'signup-subject', {
        email: null,
        allowed_scopes: ['knowledge:read'],
        grant_source: 'signup',
      }),
    ).toEqual(['knowledge:read'])
  })

  test('a delisted identity without a per-row ceiling is not admitted', () => {
    expect(
      oidcIdentityScopeCeiling(provider, 'delisted-subject', {
        email: null,
        allowed_scopes: null,
        grant_source: 'bootstrap',
      }),
    ).toBeNull()
    expect(
      oidcIdentityScopeCeiling(provider, 'delisted-subject', {
        email: null,
        allowed_scopes: [],
        grant_source: 'bootstrap',
      }),
    ).toBeNull()
  })

  test('an empty non-bootstrap ceiling never falls back to the provider set, allowlisted or not', () => {
    expect(
      oidcIdentityScopeCeiling(provider, 'subject-without-email', {
        email: null,
        allowed_scopes: null,
        grant_source: 'signup',
      }),
    ).toBeNull()
  })

  test('the signup ceiling is exactly the minimal read role', () => {
    expect([...OIDC_SIGNUP_SCOPES]).toEqual(['knowledge:read'])
  })
})
