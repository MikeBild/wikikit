// Config loader tests: precedence, dev defaults, production guards, freezing.
// Env manipulation is snapshot/restore per test — loadConfig() mutates
// process.env by design (downstream libs read it), so isolation matters.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadConfig } from '../../src/config.ts'

// Deleted (and restored) per test. Isolation needs BOTH this list and
// WIKIKIT_SKIP_DOTENV below: deleting a name here clears what Bun auto-loaded
// from the developer's .env, and the flag stops loadEnvironment() from reading
// that same file back off disk. Either alone leaks a real ANTHROPIC_API_KEY
// into the precedence/guard cases.
const MANAGED = [
  'WIKIKIT_SKIP_DOTENV',
  'NODE_ENV',
  'HOST',
  'PORT',
  'WIKIKIT_PUBLIC_URL',
  'DATABASE_URL',
  'WIKIKIT_KEY_PEPPER',
  'WIKIKIT_BOOTSTRAP_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'WIKIKIT_MODEL_SYNTHESIS',
  'WIKIKIT_MODEL_CLASSIFY',
  'WIKIKIT_MODEL_ANSWER',
  'WIKIKIT_MAX_BODY_BYTES',
  'WIKIKIT_MAX_INGEST_TOKENS',
  'WIKIKIT_INGEST_CONCURRENCY',
  'WIKIKIT_WEBHOOK_POLL_MS',
  'WIKIKIT_WEBHOOK_TIMEOUT_MS',
  'WIKIKIT_WEBHOOK_MAX_ATTEMPTS',
  'WIKIKIT_WEBHOOK_CIRCUIT_THRESHOLD',
  'WIKIKIT_WEBHOOK_ALLOW_PRIVATE',
  'WIKIKIT_TRUST_PROXY',
  'WIKIKIT_MCP_SESSION_TTL_MS',
  'WIKIKIT_MCP_MAX_SESSIONS',
  'LOG_LEVEL',
]

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const name of MANAGED) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  process.env.WIKIKIT_SKIP_DOTENV = '1'
})

afterEach(() => {
  for (const name of MANAGED) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

describe('zero-config dev defaults', () => {
  test('boots with sensible defaults and no env at all', () => {
    const config = loadConfig()
    expect(config.port).toBe(4060)
    expect(config.host).toBe('127.0.0.1')
    expect(config.production).toBe(false)
    expect(config.modelSynthesis).toBe('claude-sonnet-5')
    expect(config.modelClassify).toBe('claude-haiku-4-5')
    expect(config.modelAnswer).toBe('claude-sonnet-5')
    // .env.defaults provides a dev database URL and pepper — zero-config boot.
    expect(config.databaseUrl).toContain('postgresql://')
    expect(config.keyPepper.length).toBeGreaterThan(0)
  })

  test('ANTHROPIC_API_KEY has no default; llmConfigured reflects it', () => {
    const without = loadConfig()
    expect(without.llmApiKey).toBe('')
    expect(without.llmConfigured).toBe(false)

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const withKey = loadConfig()
    expect(withKey.llmConfigured).toBe(true)
  })

  test('webhook private targets allowed by default in dev', () => {
    expect(loadConfig().webhookAllowPrivateTargets).toBe(true)
  })
})

describe('precedence', () => {
  test('process env wins over .env.defaults', () => {
    process.env.PORT = '5099'
    process.env.WIKIKIT_MODEL_SYNTHESIS = 'claude-opus-4-8'
    const config = loadConfig()
    expect(config.port).toBe(5099)
    expect(config.modelSynthesis).toBe('claude-opus-4-8')
  })

  test('trailing slashes are stripped from URLs', () => {
    process.env.WIKIKIT_PUBLIC_URL = 'https://wiki.example.com/'
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9999/'
    const config = loadConfig()
    expect(config.publicUrl).toBe('https://wiki.example.com')
    expect(config.anthropicBaseUrl).toBe('http://127.0.0.1:9999')
  })
})

describe('validation', () => {
  test('rejects out-of-range integers', () => {
    process.env.PORT = '99999'
    expect(() => loadConfig()).toThrow(/PORT must be an integer/)
  })

  test('rejects non-numeric integers', () => {
    process.env.WIKIKIT_MAX_BODY_BYTES = 'lots'
    expect(() => loadConfig()).toThrow(/WIKIKIT_MAX_BODY_BYTES/)
  })

  test('bool parsing accepts 1/true/yes/on', () => {
    for (const raw of ['1', 'true', 'yes', 'on', 'TRUE']) {
      process.env.WIKIKIT_TRUST_PROXY = raw
      expect(loadConfig().trustProxy).toBe(true)
    }
    process.env.WIKIKIT_TRUST_PROXY = '0'
    expect(loadConfig().trustProxy).toBe(false)
  })
})

describe('production guards', () => {
  test('refuses to boot without WIKIKIT_KEY_PEPPER and DATABASE_URL', () => {
    process.env.NODE_ENV = 'production'
    expect(() => loadConfig()).toThrow(/missing production configuration/)
    expect(() => loadConfig()).toThrow(/WIKIKIT_KEY_PEPPER/)
    expect(() => loadConfig()).toThrow(/DATABASE_URL/)
  })

  test('boots in production when both secrets are set; defaults file is ignored', () => {
    process.env.NODE_ENV = 'production'
    process.env.WIKIKIT_KEY_PEPPER = 'prod-pepper'
    process.env.DATABASE_URL = 'postgresql://prod/wikikit'
    const config = loadConfig()
    expect(config.production).toBe(true)
    expect(config.keyPepper).toBe('prod-pepper')
    // .env.defaults must NOT have leaked the dev pepper/database in.
    expect(config.databaseUrl).toBe('postgresql://prod/wikikit')
    // Private webhook targets are denied by default in production.
    expect(config.webhookAllowPrivateTargets).toBe(false)
  })

  test('ANTHROPIC_API_KEY is NOT required in production (LLM-free deploys)', () => {
    process.env.NODE_ENV = 'production'
    process.env.WIKIKIT_KEY_PEPPER = 'prod-pepper'
    process.env.DATABASE_URL = 'postgresql://prod/wikikit'
    const config = loadConfig()
    expect(config.llmConfigured).toBe(false)
  })
})

describe('shape', () => {
  test('config object is frozen', () => {
    const config = loadConfig()
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('version is a semver-ish string sourced from package.json', () => {
    const config = loadConfig()
    expect(config.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
