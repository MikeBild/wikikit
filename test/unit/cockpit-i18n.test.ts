import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATALOGS,
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
