import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import {
  CATALOGS,
  DE_PHRASES,
  LOCALE_TAGS,
  formatDateTime,
  formatNumber,
  interpolate,
  translate,
  type TranslationKey,
} from '../../apps/cockpit/src/lib/i18n'
import {
  LOCALE_STORAGE_KEY,
  createLocaleStore,
  resolveLocale,
  type LocaleEnvironment,
} from '../../apps/cockpit/src/lib/locale-store'

const PRESENTATION_PROPS = new Set([
  'aria-label',
  'confirmLabel',
  'description',
  'empty',
  'hint',
  'label',
  'placeholder',
  'title',
])

const TECHNICAL_PHRASES = new Set([
  'API',
  'Export',
  'In',
  'Markdown',
  'Name',
  'Name (optional)',
  'Open Knowledge Format',
  'OpenAPI',
  'Revision',
  'Slug',
  'System',
  'Tokens',
  'Version',
  'WIKIKIT',
  'Wiki',
  'WikiKit',
  'Wikis',
  'Webhooks',
  'admin',
  'entra',
  'every-link-uses-this',
  'https://example.com/handbook',
  'https://example.com/hooks/wikikit',
  'kubernetes, on-call, postmortem',
  'knowledge:approve',
  'person@example.com',
  'platform-runbooks',
  'stale_base',
  'wikikit',
])

function cockpitTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? cockpitTsxFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

function normalizePhrase(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function staticPresentationPhrases(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const phrases: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const value = normalizePhrase(node.text)
      if (/[A-Za-zÄÖÜäöüß]/.test(value)) phrases.push(value)
    }
    if (ts.isJsxAttribute(node) && PRESENTATION_PROPS.has(node.name.getText(source)) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) phrases.push(normalizePhrase(node.initializer.text))
      if (
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression &&
        ts.isStringLiteral(node.initializer.expression)
      ) {
        phrases.push(normalizePhrase(node.initializer.expression.text))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return phrases
}

function fakeLocaleEnvironment({
  stored = null,
  languages = ['en-US'],
}: { stored?: string | null; languages?: string[] } = {}) {
  const storage = new Map<string, string>()
  if (stored !== null) storage.set(LOCALE_STORAGE_KEY, stored)
  const applied: string[] = []
  const env: LocaleEnvironment = {
    read: (key) => storage.get(key) ?? null,
    write: (key, value) => storage.set(key, value),
    remove: (key) => storage.delete(key),
    languages: () => languages,
    apply: (locale) => applied.push(locale),
  }
  return { env, storage, applied }
}

describe('the typed English and German Cockpit catalogs', () => {
  test('have exactly the same keys and never return translation keys', () => {
    const english = Object.keys(CATALOGS.en).sort()
    expect(Object.keys(CATALOGS.de).sort()).toEqual(english)
    for (const key of english as TranslationKey[]) {
      expect(translate('en', key)).not.toBe(key)
      expect(translate('de', key)).not.toBe(key)
    }
  })

  test('interpolates named values and formats dates and numbers by locale', () => {
    expect(interpolate('{count} {unit}', { count: 12, unit: 'pages' })).toBe('12 pages')
    expect(LOCALE_TAGS).toEqual({ en: 'en-US', de: 'de-DE' })
    expect(formatNumber('en', 1234)).toBe('1,234')
    expect(formatNumber('de', 1234)).toBe('1.234')
    expect(formatDateTime('de', '2026-08-10T12:00:00Z')).not.toBe(formatDateTime('en', '2026-08-10T12:00:00Z'))
  })

  test('covers every static presentation phrase exposed by Cockpit pages', () => {
    const englishCatalog = new Map(
      Object.entries(CATALOGS.en).map(([key, value]) => [value, CATALOGS.de[key as TranslationKey]]),
    )
    const root = join(import.meta.dir, '../../apps/cockpit/src')
    const missing = new Set(
      cockpitTsxFiles(root)
        .flatMap(staticPresentationPhrases)
        .filter((phrase) => {
          if (!phrase || TECHNICAL_PHRASES.has(phrase)) return false
          const catalogTranslation = englishCatalog.get(phrase)
          if (catalogTranslation && catalogTranslation !== phrase) return false
          const phraseTranslation = DE_PHRASES[phrase as keyof typeof DE_PHRASES]
          return !phraseTranslation || phraseTranslation === phrase
        }),
    )
    expect([...missing].sort()).toEqual([])
  })
})

describe('locale preference and automatic detection', () => {
  test('detects German tags and otherwise falls back to English', () => {
    expect(resolveLocale(['de-DE', 'en-US'])).toBe('de')
    expect(resolveLocale(['de-AT'])).toBe('de')
    expect(resolveLocale(['fr-FR'])).toBe('en')
    expect(resolveLocale([])).toBe('en')
  })

  test('persists explicit choices, supports auto and tolerates invalid storage', () => {
    const fake = fakeLocaleEnvironment({ languages: ['de-DE'] })
    const store = createLocaleStore(fake.env)
    expect(store.snapshot()).toEqual({ preference: 'auto', locale: 'de' })
    store.set('en')
    expect(fake.storage.get(LOCALE_STORAGE_KEY)).toBe('en')
    expect(store.snapshot()).toEqual({ preference: 'en', locale: 'en' })
    store.set('auto')
    expect(fake.storage.has(LOCALE_STORAGE_KEY)).toBe(false)
    expect(createLocaleStore(fakeLocaleEnvironment({ stored: 'invalid', languages: ['de'] }).env).snapshot()).toEqual({
      preference: 'auto',
      locale: 'de',
    })
  })
})

describe('the localized user menu', () => {
  const shell = readFileSync(join(import.meta.dir, '../../apps/cockpit/src/app/shell.tsx'), 'utf8')
  const main = readFileSync(join(import.meta.dir, '../../apps/cockpit/src/main.tsx'), 'utf8')

  test('contains profile, language, theme and sign-out in one footer menu', () => {
    for (const id of [
      'account-menu-trigger',
      'account-menu',
      'account-profile-menu',
      'account-language-menu',
      'account-theme-menu',
      'account-sign-out',
    ]) {
      expect(shell).toContain(`data-testid="${id}"`)
    }
    expect(shell).not.toContain('data-testid="theme-toggle"')
    expect(shell).not.toContain('data-testid="sign-out"')
  })

  test('mounts the locale provider above session and router', () => {
    expect(main.indexOf('<I18nProvider>')).toBeLessThan(main.indexOf('<SessionGate>'))
  })
})
