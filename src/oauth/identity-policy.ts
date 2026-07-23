import type { OidcProviderConfig } from '../config.ts'

export interface OidcIdentity {
  subject: string
  /** Present only when the provider explicitly asserted email_verified=true. */
  email: string | null
}

export function isOidcIdentityAllowed(
  provider: OidcProviderConfig,
  subject: string,
  verifiedEmail: string | null,
): boolean {
  return (
    provider.allowedSubjects.includes(subject) ||
    (verifiedEmail !== null && provider.allowedEmails.includes(verifiedEmail))
  )
}

export function oidcIdentityFromClaims(
  provider: OidcProviderConfig,
  claims: { sub?: unknown; email?: unknown; email_verified?: unknown } | undefined,
): OidcIdentity {
  const subject = typeof claims?.sub === 'string' ? claims.sub : ''
  if (!subject) throw new Error('OIDC identity must contain sub')

  const email =
    claims?.email_verified === true && typeof claims.email === 'string' && claims.email.trim()
      ? claims.email.trim().toLowerCase()
      : null
  if (!isOidcIdentityAllowed(provider, subject, email)) {
    throw new Error('OIDC account is not allowed to access WikiKit')
  }
  return { subject, email }
}
