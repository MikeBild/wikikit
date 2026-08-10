import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { CONSOLE_LOCALE } from './relative-time.ts'

/** The shadcn class merger. Later utilities win over earlier ones of the same family. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * An exact instant, spelled out. Deliberately not relative: this is what a
 * concept's revision history prints, where the ordering of two revisions
 * seconds apart is the whole point. `formatRelative` in lib/relative-time.ts is
 * the other half.
 *
 * The locale is the console's, not the browser's. `toLocaleString()` with no
 * argument is where `29.07.2026, 21:43:19` came from on a German laptop reading
 * an English interface — a format the rest of the page cannot corroborate.
 */
export function formatInstant(value: string | null | undefined, locale: string = CONSOLE_LOCALE): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString(locale)
}
