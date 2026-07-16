// Webhook secret handling + SSRF endpoint validation.
//
// WHY reversible encryption instead of hashing: endpoint signing secrets must
// be reproducible at delivery time (every delivery re-computes the Standard
// Webhooks HMAC), so unlike API keys they cannot be stored as one-way hashes.
// They are encrypted at rest with AES-256-GCM keyed off the server pepper —
// a database dump alone never yields usable signing secrets.
// Format: base64(iv).base64(tag).base64(ciphertext).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { ValidationError } from './domain/errors.ts'

// WHY sha256(pepper) as the key: the pepper is an operator-chosen string of
// arbitrary length; hashing normalizes it to exactly the 32 bytes AES-256
// requires without imposing format rules on WIKIKIT_KEY_PEPPER.
function keyFrom(pepper: string): Buffer {
  if (!pepper) throw new Error('WIKIKIT_KEY_PEPPER is not configured')
  return createHash('sha256').update(String(pepper)).digest()
}

export function encryptSecret(plaintext: string, pepper: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFrom(pepper), iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`
}

export function decryptSecret(encrypted: string, pepper: string): string {
  const [iv, tag, ciphertext] = String(encrypted).split('.')
  if (!iv || !tag || !ciphertext) throw new Error('malformed encrypted secret')
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(pepper), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

// whsec_ prefix per the Standard Webhooks convention so consumers can
// recognize (and secret-scan) the value; 24 random bytes ≈ 192 bits entropy.
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`
}

// WHY a hand-rolled range table instead of a dependency: the blocked set is
// small, security-critical, and must be auditable at a glance. Covers
// loopback, RFC1918 private, CGNAT, link-local (incl. 169.254.169.254 cloud
// metadata), benchmarking, multicast/reserved.
function isBlockedIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // this-net, private-10, loopback, multicast/reserved
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
    (a === 192 && b === 168) || // private 192.168/16
    (a === 198 && (b === 18 || b === 19)) // benchmarking 198.18/15
  )
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
    return true // link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique-local fc00::/7
  if (lower.startsWith('ff')) return true // multicast
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped bypass attempt
  if (mapped) return isBlockedIPv4(mapped[1]!)
  return false
}

/** True when the ip must never be a webhook delivery target. Unparseable input is blocked (fail closed). */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isBlockedIPv4(ip)
  if (version === 6) return isBlockedIPv6(ip)
  return true
}

/**
 * Validates a user-supplied outbound URL against SSRF: enforces http(s),
 * forbids embedded credentials, and resolves the host to reject
 * loopback/private/link-local and cloud-metadata addresses. Used by BOTH
 * outbound surfaces — webhook endpoints and URL ingest (the plan's review
 * lens requires the guard on each).
 *
 * `allowInsecure` (dev: WIKIKIT_WEBHOOK_ALLOW_PRIVATE) permits http and
 * private targets so local delivery stubs work; production defaults to the
 * strict path. `allowHttp` relaxes ONLY the https requirement (URL ingest
 * legitimately fetches public http:// pages) while keeping the private-address
 * block. Throws ValidationError (400 bad_request) — a rejected URL is a
 * caller mistake, not a server fault.
 *
 * Residual risk, documented on purpose: the DNS answer checked here and the
 * one the subsequent fetch dials are separate lookups, so a 0-TTL rebinding
 * host can still answer public here and private for the fetch. Re-checking
 * per send/hop NARROWS that window; closing it entirely would require dialing
 * the vetted IP directly (custom dispatcher), which Bun's fetch does not
 * expose today. Callers must never claim the window is closed.
 */
export async function assertDeliverableUrl(
  rawUrl: string,
  { allowInsecure = false, allowHttp = false } = {},
): Promise<string> {
  let url: URL
  try {
    url = new URL(String(rawUrl))
  } catch {
    throw new ValidationError('url must be an absolute URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ValidationError('url must be http(s) without credentials')
  }
  if (url.protocol === 'http:' && !allowInsecure && !allowHttp) {
    throw new ValidationError('url must use https')
  }
  if (allowInsecure) return url.toString()
  // WHY resolve-and-check instead of hostname pattern matching: '127.0.0.1'
  // has infinite DNS aliases; only the resolved addresses are authoritative.
  // ALL addresses must be clean — one blocked A record fails the whole URL,
  // otherwise a multi-record host could rotate a private address in later.
  let addresses: { address: string }[]
  try {
    addresses = await lookup(url.hostname, { all: true })
  } catch {
    throw new ValidationError('url host does not resolve')
  }
  if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new ValidationError('url resolves to a disallowed (private/loopback) address')
  }
  return url.toString()
}
