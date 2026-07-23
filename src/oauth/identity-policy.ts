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

/** Who owns a wk_oauth_identities row (0028). AuthZ never branches on it
 *  beyond the transitional NULL-ceiling inheritance for 'bootstrap' rows. */
export type IdentityGrantSource = 'admin' | 'seed' | 'signup' | 'bootstrap'

export interface IdentityGrantRow {
  email: string | null
  allowed_scopes: string[] | null
  grant_source: IdentityGrantSource | string
}

/**
 * Per-identity permission ceiling for a wk_oauth_identities row, or null when
 * the identity is not admitted. Since 0028 the ROW is the single AuthZ truth:
 * a stored allowed_scopes array IS the ceiling, regardless of the ENV
 * allowlist — an operator-managed ('admin'/'seed') grant always wins over the
 * allowlist. Only a 'bootstrap' row that still carries NULL scopes (written
 * before 0028 mirrored the allowlist into the row) transitionally inherits
 * the provider's allowedScopes, and only while the identity is actually
 * allowlisted. Callers filter revoked_at themselves (revoked rows never reach
 * this function) — a revoked row denies, allowlist or not.
 */
export function oidcIdentityScopeCeiling(
  provider: OidcProviderConfig,
  subject: string,
  row: IdentityGrantRow | undefined,
): string[] | null {
  if (!row) return null
  if (row.allowed_scopes?.length) return row.allowed_scopes
  if (
    row.grant_source === 'bootstrap' &&
    isOidcIdentityAllowed(provider, subject, row.email ? row.email.toLowerCase() : null)
  ) {
    return provider.allowedScopes
  }
  return null
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
