import { CONSOLE_LOCALE } from '@/lib/relative-time'
import type { DomainState } from '@/lib/tokens'

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'unknown'

const BADGE_TONE: Record<DomainState, Tone> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
}

export function toneFor(state: DomainState): Tone {
  return BADGE_TONE[state]
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString(CONSOLE_LOCALE)
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function windowLabel(from: string, to: string): string | null {
  const start = new Date(from).valueOf()
  const end = new Date(to).valueOf()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const span = end - start
  if (span < 2 * HOUR_MS) {
    const minutes = Math.round(span / MINUTE_MS)
    return minutes === 60 ? 'the last hour' : `the last ${minutes} minutes`
  }
  if (span < 2 * DAY_MS) return `the last ${Math.round(span / HOUR_MS)} hours`
  return `the last ${Math.round(span / DAY_MS)} days`
}

export function durationHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) return '—'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${Math.round(hours)} h`
  return `${Math.round(hours / 24)} days`
}

export function staleShare(concepts: number, stale: number): string {
  if (!Number.isFinite(concepts) || concepts <= 0) return '—'
  if (!Number.isFinite(stale) || stale < 0) return '—'
  return `${Math.round((stale / concepts) * 100)}%`
}
