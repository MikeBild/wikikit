import { describe, expect, test } from 'bun:test'
import type { OidcProviderConfig } from '../../src/config.ts'
import { isOidcIdentityAllowed, oidcIdentityFromClaims } from '../../src/oauth/identity-policy.ts'

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
})
