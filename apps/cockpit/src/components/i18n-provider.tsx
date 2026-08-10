import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { I18nContext, localeStore, type I18nValue } from '@/lib/i18n-context'
import { formatDateTime, formatNumber, translate, translateText } from '@/lib/i18n'

export function I18nProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(localeStore.subscribe, localeStore.snapshot, localeStore.snapshot)
  const value = useMemo<I18nValue>(
    () => ({
      ...snapshot,
      setPreference: localeStore.set,
      t: (key, values) => translate(snapshot.locale, key, values),
      text: (source, values) => translateText(snapshot.locale, source, values),
      number: (number) => formatNumber(snapshot.locale, number),
      dateTime: (date) => formatDateTime(snapshot.locale, date),
    }),
    [snapshot],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
