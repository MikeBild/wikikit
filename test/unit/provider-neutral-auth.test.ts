import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function productionSources(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const target = join(path, name)
    return statSync(target).isDirectory()
      ? productionSources(target)
      : /\.(ts|mjs)$/.test(name) && !name.includes('.test.')
        ? [target]
        : []
  })
}

describe('provider-neutral auth architecture', () => {
  test('keeps vendor names, legacy discriminators and fixed provider routes out of runtime auth', () => {
    const concreteProvider = new RegExp(['fire' + 'base', 'supa' + 'base'].join('|'), 'i')
    const files = [
      ...productionSources('src/oauth'),
      'src/db/migrations/0005_wk_oauth_external_identity.sql',
      'src/db/migrations/0006_wk_oauth_provider_metadata.sql',
      'src/config.ts',
      'src/http/auth.ts',
      'src/app.ts',
    ]
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(source).not.toMatch(concreteProvider)
    expect(source).not.toMatch(/login\/(?:api-key|token-bridge)/i)
    expect(source).not.toMatch(/params\.get\(['"]id_token['"]\)/)
    expect(source).toContain('/v1/identity/login/start')
    expect(source).toContain('/v1/identity/login/callback')
    expect(source).toContain('/v1/identity/logout')
  })

  test('keeps browser-auth documentation provider-neutral', () => {
    const concreteProvider = new RegExp(['fire' + 'base', 'supa' + 'base'].join('|'), 'i')
    const docs = ['docs/CONFIGURATION.md', 'CHANGELOG.md'].map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(docs).not.toMatch(concreteProvider)
  })
})
