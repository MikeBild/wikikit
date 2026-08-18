import { describe, expect, test } from 'bun:test'
import {
  formatCount,
  formatCurrency,
  formatRatio,
  unpricedModels,
  usageSeries,
} from '../../../apps/cockpit/src/pages/model-usage.logic.ts'

describe('model usage presentation rules', () => {
  test('does not present a wholly unpriced bucket as free', () => {
    expect(formatCurrency(0, 2, 2, 'en-US')).toBe('—')
    expect(formatCurrency(1.25, 2, 1, 'en-US')).toBe('$1.25')
  })

  test('formats measured ratios and counts in the requested locale', () => {
    expect(formatRatio(0.125, 'de-DE')).toBe('12,5\u00a0%')
    expect(formatRatio(null, 'de-DE')).toBe('—')
    expect(formatCount(1234, 'de-DE')).toBe('1.234')
  })

  test('preserves unknown price buckets as chart gaps with a separate marker', () => {
    const [point] = usageSeries(
      [
        {
          ts: '2026-08-18T10:00:00.000Z',
          calls: 3,
          tokens: { input: 100, output: 20, cache_read: 30, total: 150 },
          cost_usd: { total: 0 },
          unpriced: { calls: 3, tokens: { total: 150 }, models: ['zeta'] },
          cache_hit_ratio: 0.23,
        },
      ],
      'en-US',
    )
    expect(point?.cost).toBeNull()
    expect(point?.unpricedCalls).toBe(3)
  })

  test('sorts and deduplicates unpriced model names', () => {
    expect(unpricedModels(['zeta', 'alpha', 'zeta'])).toBe('alpha, zeta')
  })
})
