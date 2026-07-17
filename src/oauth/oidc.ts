// Standards-based OIDC browser login for WikiKit's remote MCP OAuth server.
// Each provider is explicitly configured and its issuer is discovered through
// openid-client; no browser-provided issuer, endpoint or return URL is trusted.
import * as oidc from 'openid-client'
import type { OidcProviderConfig } from '../config.ts'

export interface OidcStart {
  authorizationUrl: string
  nonce: string
  codeVerifier: string
}

const discovered = new Map<string, Promise<oidc.Configuration>>()

async function configuration(provider: OidcProviderConfig): Promise<oidc.Configuration> {
  const key = `${provider.issuer}\u0000${provider.clientId}`
  let pending = discovered.get(key)
  if (!pending) {
    pending = oidc.discovery(
      new URL(provider.issuer),
      provider.clientId,
      provider.clientSecret ? provider.clientSecret : undefined,
    )
    discovered.set(key, pending)
  }
  try {
    return await pending
  } catch (error) {
    // A transient discovery failure must not poison all later login attempts.
    discovered.delete(key)
    throw error
  }
}

export async function startOidcLogin(args: {
  provider: OidcProviderConfig
  redirectUri: string
  state: string
}): Promise<OidcStart> {
  const config = await configuration(args.provider)
  const codeVerifier = oidc.randomPKCECodeVerifier()
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
  const nonce = oidc.randomNonce()
  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: args.redirectUri,
    scope: args.provider.scopes,
    state: args.state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return { authorizationUrl: authorizationUrl.toString(), nonce, codeVerifier }
}

export interface OidcIdentity {
  subject: string
  email: string
}

export async function finishOidcLogin(args: {
  provider: OidcProviderConfig
  redirectUri: string
  callbackUrl: URL
  state: string
  nonce: string
  codeVerifier: string
}): Promise<OidcIdentity> {
  const config = await configuration(args.provider)
  const callback = new URL(args.redirectUri)
  callback.search = args.callbackUrl.search
  const tokens = await oidc.authorizationCodeGrant(config, callback, {
    expectedState: args.state,
    expectedNonce: args.nonce,
    pkceCodeVerifier: args.codeVerifier,
  })
  const claims = tokens.claims() as { sub?: unknown; email?: unknown; email_verified?: unknown } | undefined
  const subject = typeof claims?.sub === 'string' ? claims.sub : ''
  const email = typeof claims?.email === 'string' ? claims.email.trim().toLowerCase() : ''
  // Email is the policy anchor. Requiring the verified standard claim avoids
  // treating a mutable profile attribute as account proof.
  const verified = claims?.email_verified === true
  if (!subject || !email || !verified) throw new Error('OIDC identity must contain sub, email and email_verified=true')
  if (!args.provider.allowedEmails.includes(email)) throw new Error('OIDC account is not allowed to access WikiKit')
  return { subject, email }
}
