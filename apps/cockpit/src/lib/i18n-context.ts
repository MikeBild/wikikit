import { createContext, useContext } from 'react'
import { type Locale, type TranslationKey } from './i18n'
import { createLocaleStore, LOCALE_STORAGE_KEY, type LocaleEnvironment, type LocalePreference } from './locale-store'

function browserLocaleEnvironment(): LocaleEnvironment {
  return {
    read: (key) => {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
    write: (key, value) => {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* The explicit choice still applies for this tab when storage is blocked. */
      }
    },
    remove: (key) => {
      try {
        window.localStorage.removeItem(key)
      } catch {
        /* Automatic detection still applies for this tab when storage is blocked. */
      }
    },
    languages: () => window.navigator.languages,
    apply: (locale) => {
      document.documentElement.lang = locale
    },
    watchSystem: (onChange) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key === LOCALE_STORAGE_KEY || event.key === null) onChange()
      }
      window.addEventListener('languagechange', onChange)
      window.addEventListener('storage', onStorage)
      return () => {
        window.removeEventListener('languagechange', onChange)
        window.removeEventListener('storage', onStorage)
      }
    },
  }
}

export const localeStore = createLocaleStore(browserLocaleEnvironment())

export interface I18nValue {
  locale: Locale
  preference: LocalePreference
  setPreference(preference: LocalePreference): void
  t(key: TranslationKey, values?: Readonly<Record<string, string | number>>): string
  number(value: number): string
  dateTime(value: string | number | Date): string
}

export const I18nContext = createContext<I18nValue | null>(null)

export { LOCALE_STORAGE_KEY }
export type { LocalePreference }

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n outside I18nProvider')
  return value
}
