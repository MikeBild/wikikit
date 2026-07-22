import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../../src/config.ts'
import { publicLoginProviders } from '../../src/oauth/server.ts'

function productionSources(path: string): string[] {
  if (statSync(path).isFile()) return [path]
  return readdirSync(path).flatMap((name) => productionSources(join(path, name)))
}

describe('GET /v1/identity/providers', () => {
  test('returns the canonical safe SSO-first UI matrix', async () => {
    const config: Pick<Config, 'oauthProviders'> = {
      oauthProviders: [
        { protocol: 'api_key' as const, id: 'api-key', label: 'WikiKit API key' },
        {
          protocol: 'token_bridge' as const,
          id: 'workforce',
          label: 'Configured deployment label',
          loginUrl: 'https://login.example.com',
          issuer: 'https://issuer.example.com',
          audience: 'wikikit',
          jwksUrl: 'https://issuer.example.com/jwks',
          subjectClaim: 'sub',
          emailClaim: 'email',
          emailVerifiedClaim: 'email_verified',
          allowedEmails: [],
          allowedScopes: ['knowledge:read'],
        },
      ],
    }
    expect(publicLoginProviders(config)).toEqual([
      { protocol: 'token_bridge', id: 'workforce', label: 'SSO', login_url: 'https://login.example.com' },
      { protocol: 'api_key', id: 'api-key', label: 'API key' },
    ])
  })

  test('browser-auth runtime and documentation contain protocols, never provider products or fixed routes', () => {
    const concreteProvider = new RegExp(['fire' + 'base', 'supa' + 'base'].join('|'), 'i')
    const fixedRoute = /\/v1\/identity\/login\/(?:oidc|api-key|token-bridge)(?:\/|['"`])/i
    const runtime = [...productionSources('src/oauth'), 'src/config.ts', 'src/app.ts', 'src/http/auth.ts']
      .filter((file) => !file.endsWith('.test.ts'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    const docs = ['README.md', 'docs/CONFIGURATION.md', 'docs/CONTRACTS.md', 'docs/llms-full.txt']
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')

    expect(runtime).not.toMatch(concreteProvider)
    expect(runtime).not.toMatch(fixedRoute)
    expect(docs).not.toMatch(concreteProvider)
  })
})
