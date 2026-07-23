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
          protocol: 'oidc' as const,
          id: 'workforce',
          label: 'Configured deployment label',
          issuer: 'https://issuer.example.com',
          clientId: 'wikikit-test',
          scopes: 'openid email profile',
          allowedEmails: [],
          allowedSubjects: ['operator-subject'],
          allowedScopes: ['knowledge:read'],
        },
      ],
    }
    expect(publicLoginProviders(config)).toEqual([
      { protocol: 'oidc', id: 'workforce', label: 'SSO', issuer: 'https://issuer.example.com' },
      { protocol: 'api_key', id: 'api-key', label: 'API key' },
    ])
  })

  test('browser-auth runtime and documentation contain protocols, never provider products or fixed routes', () => {
    const concreteProvider = new RegExp(['fire' + 'base', 'supa' + 'base'].join('|'), 'i')
    const fixedRoute = /\/v1\/identity\/login\/(?:oidc|api-key)(?:\/|['"`])/i
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
