import type { OidcProviderConfig } from '../config.ts'

export interface OidcIdentity {
  subject: string
  /** Present only when the provider explicitly asserted email_verified=true. */
  email: string | null
}

/**
 * Minimal per-identity permission ceiling granted at self-signup
 * (WIKIKIT_OAUTH_ENABLE_SIGNUP). Deliberately the smallest useful role —
 * NEVER the provider's allowed_scopes set: an unknown identity that signs
 * itself up may read, nothing more, until an operator says otherwise.
 */
export const OIDC_SIGNUP_SCOPES: ReadonlyArray<'knowledge:read'> = ['knowledge:read']

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

/**
 * Per-identity permission ceiling for a wk_oauth_identities row, or null when
 * the identity is not admitted. Allowlisted identities inherit the provider's
 * allowed_scopes. A row that is NOT allowlisted is admitted only through its
 * own stored ceiling (allowed_scopes, written once at self-signup) — a row
 * whose allowlist entry was removed carries none, so removing an allowlist
 * entry keeps revoking access exactly as it did before signup existed.
 */
export function oidcIdentityScopeCeiling(
  provider: OidcProviderConfig,
  subject: string,
  row: { email: string | null; allowed_scopes: string[] | null } | undefined,
): string[] | null {
  if (!row) return null
  if (isOidcIdentityAllowed(provider, subject, row.email ? row.email.toLowerCase() : null)) {
    return provider.allowedScopes
  }
  return row.allowed_scopes?.length ? row.allowed_scopes : null
}

export function oidcIdentityFromClaims(
  provider: OidcProviderConfig,
  claims: { sub?: unknown; email?: unknown; email_verified?: unknown } | undefined,
  options?: {
    /**
     * Skip the allowlist rejection and return the identity even when it is
     * unknown. Only the SSO-callback signup branch may pass true — every
     * other caller keeps the deny-by-default contract.
     */
    allowUnknown?: boolean
  },
): OidcIdentity {
  const subject = typeof claims?.sub === 'string' ? claims.sub : ''
  if (!subject) throw new Error('OIDC identity must contain sub')

  const email =
    claims?.email_verified === true && typeof claims.email === 'string' && claims.email.trim()
      ? claims.email.trim().toLowerCase()
      : null
  if (!options?.allowUnknown && !isOidcIdentityAllowed(provider, subject, email)) {
    throw new Error('OIDC account is not allowed to access WikiKit')
  }
  return { subject, email }
}
