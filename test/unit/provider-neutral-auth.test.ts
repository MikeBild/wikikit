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
    const files = [...productionSources('src/oauth'), 'src/config.ts', 'src/http/auth.ts', 'src/app.ts']
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(source).not.toMatch(/firebase|FIREBASE_|login\/(?:firebase|api-key|token-bridge)/i)
    expect(source).not.toMatch(/params\.get\(['"]id_token['"]\)/)
    expect(source).toContain('/v1/identity/login/start')
    expect(source).toContain('/v1/identity/login/callback')
    expect(source).toContain('/v1/identity/logout')
  })
})
