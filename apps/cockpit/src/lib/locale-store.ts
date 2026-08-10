import { LOCALES, type Locale } from './i18n'

export type LocalePreference = Locale | 'auto'
export const LOCALE_STORAGE_KEY = 'wikikit-cockpit-locale'

export interface LocaleSnapshot {
  preference: LocalePreference
  locale: Locale
}

export interface LocaleEnvironment {
  read(key: string): string | null
  write(key: string, value: string): void
  remove(key: string): void
  languages(): readonly string[]
  apply(locale: Locale): void
  watchSystem?(onChange: () => void): () => void
}

export interface LocaleStore {
  subscribe(listener: () => void): () => void
  snapshot(): LocaleSnapshot
  set(preference: LocalePreference): void
}

function isLocale(value: string | null): value is Locale {
  return LOCALES.some((locale) => locale === value)
}

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.trim().toLowerCase().split('-')[0]
    if (base === 'de') return 'de'
    if (base === 'en') return 'en'
  }
  return 'en'
}

export function createLocaleStore(env: LocaleEnvironment): LocaleStore {
  function read(): LocaleSnapshot {
    const stored = env.read(LOCALE_STORAGE_KEY)
    const preference: LocalePreference = isLocale(stored) ? stored : 'auto'
    return { preference, locale: preference === 'auto' ? resolveLocale(env.languages()) : preference }
  }

  let snapshot = read()
  const listeners = new Set<() => void>()
  env.apply(snapshot.locale)

  function publish(): void {
    const next = read()
    if (next.preference === snapshot.preference && next.locale === snapshot.locale) return
    snapshot = next
    env.apply(snapshot.locale)
    for (const listener of listeners) listener()
  }

  env.watchSystem?.(publish)

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => snapshot,
    set(preference) {
      if (preference === 'auto') env.remove(LOCALE_STORAGE_KEY)
      else env.write(LOCALE_STORAGE_KEY, preference)
      publish()
    },
  }
}
