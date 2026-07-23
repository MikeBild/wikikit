// Standards-based OIDC browser login for WikiKit's remote MCP OAuth server.
// Each provider is explicitly configured and its issuer is discovered through
// openid-client; no browser-provided issuer, endpoint or return URL is trusted.
import * as oidc from 'openid-client'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { OidcProviderConfig } from '../config.ts'
import { oidcIdentityFromClaims, type OidcIdentity } from './identity-policy.ts'

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

const assertionMetadata = new Map<string, Promise<{ issuer: string; jwks_uri: string }>>()
const assertionKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function discoveryUrl(issuer: string): URL {
  const endpoint = new URL(issuer)
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`
  endpoint.search = ''
  endpoint.hash = ''
  return endpoint
}

async function providerMetadata(provider: OidcProviderConfig): Promise<{ issuer: string; jwks_uri: string }> {
  let pending = assertionMetadata.get(provider.issuer)
  if (!pending) {
    pending = (async () => {
      const endpoint = discoveryUrl(provider.issuer)
      const response = await fetch(endpoint, { headers: { accept: 'application/json' }, redirect: 'error' })
      if (!response.ok) throw new Error('OIDC discovery failed')
      const metadata = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown }
      if (metadata.issuer !== provider.issuer || typeof metadata.jwks_uri !== 'string') {
        throw new Error('OIDC discovery metadata is invalid')
      }
      return { issuer: metadata.issuer, jwks_uri: metadata.jwks_uri }
    })()
    assertionMetadata.set(provider.issuer, pending)
  }
  try {
    return await pending
  } catch (error) {
    assertionMetadata.delete(provider.issuer)
    throw error
  }
}

/** Verify a provider assertion for the provider-neutral identity-session exchange. */
export async function verifyOidcIdentityToken(args: {
  provider: OidcProviderConfig
  identityToken: string
}): Promise<OidcIdentity> {
  const metadata = await providerMetadata(args.provider)
  let keySet = assertionKeys.get(metadata.jwks_uri)
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(metadata.jwks_uri))
    assertionKeys.set(metadata.jwks_uri, keySet)
  }
  const { payload } = await jwtVerify(args.identityToken, keySet, {
    issuer: metadata.issuer,
    audience: args.provider.clientId,
  })
  return oidcIdentityFromClaims(args.provider, payload)
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
  return oidcIdentityFromClaims(args.provider, claims)
}
