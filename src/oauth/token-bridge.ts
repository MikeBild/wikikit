// Generic JWT assertion verifier for externally hosted login bridges.
import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface BridgedIdentity {
  subject: string
  email: string
}

function readClaim(payload: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return (value as Record<string, unknown>)[segment]
  }, payload)
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function verifyBridgedIdentity(args: {
  token: string
  issuer: string
  audience: string
  jwksUrl: string
  subjectClaim?: string
  emailClaim?: string
  emailVerifiedClaim?: string
  allowedEmails: readonly string[]
}): Promise<BridgedIdentity> {
  if (!args.issuer || !args.audience || !args.jwksUrl || !args.allowedEmails.length) {
    throw new Error('token bridge is not configured')
  }
  let jwks = keySets.get(args.jwksUrl)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(args.jwksUrl))
    keySets.set(args.jwksUrl, jwks)
  }
  const { payload } = await jwtVerify(args.token, jwks, { issuer: args.issuer, audience: args.audience })
  const rawSubject = readClaim(payload, args.subjectClaim ?? 'sub')
  const rawEmail = readClaim(payload, args.emailClaim ?? 'email')
  const subject = typeof rawSubject === 'string' ? rawSubject : ''
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : ''
  if (!subject || !email || readClaim(payload, args.emailVerifiedClaim ?? 'email_verified') !== true) {
    throw new Error('identity has no verified email')
  }
  if (!args.allowedEmails.includes(email)) throw new Error('this identity is not allowed to access WikiKit')
  return { subject, email }
}
