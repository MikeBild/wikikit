// Firebase ID-token verification for the human side of the MCP OAuth bridge.
// The Firebase Web API key is deliberately public; trust is established only
// by verifying Google's RS256 signature, issuer, audience, expiry and the
// explicit WikiKit email allow-list.
import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface FirebaseIdentity {
  subject: string
  email: string
}

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
)

export async function verifyFirebaseIdToken(args: {
  token: string
  projectId: string
  allowedEmails: readonly string[]
}): Promise<FirebaseIdentity> {
  if (!args.projectId || !args.allowedEmails.length) throw new Error('Firebase OAuth login is not configured')
  const issuer = `https://securetoken.google.com/${args.projectId}`
  const { payload } = await jwtVerify(args.token, JWKS, {
    issuer,
    audience: args.projectId,
    algorithms: ['RS256'],
  })
  const subject = typeof payload.sub === 'string' ? payload.sub : ''
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (!subject || !email || payload.email_verified !== true)
    throw new Error('Firebase login has no verified email identity')
  if (!args.allowedEmails.includes(email)) throw new Error('this Firebase account is not allowed to access WikiKit')
  return { subject, email }
}
