import { describe, expect, test } from 'bun:test'
import { packEvidence } from '../../src/query/answer.ts'

describe('answer evidence token packing', () => {
  const item = (id: string, chars: number) => ({ id, text: id.repeat(Math.ceil(chars / id.length)).slice(0, chars) })

  test('reports overflow and skips an oversized middle block so later evidence can fit', () => {
    const packed = packEvidence([item('a', 8), item('b', 80), item('c', 8)], 4)
    expect(packed.items.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(packed).toMatchObject({ tokens_used: 4, tokens_budget: 4, truncated: true })
  })

  test('handles no candidates and a zero budget deterministically', () => {
    expect(packEvidence([], 10)).toEqual({ items: [], tokens_used: 0, tokens_budget: 10, truncated: false })
    expect(packEvidence([item('a', 4)], 0)).toEqual({ items: [], tokens_used: 0, tokens_budget: 0, truncated: true })
  })

  test('floors a fractional budget before packing', () => {
    expect(packEvidence([item('a', 8)], 2.9)).toMatchObject({ tokens_used: 2, tokens_budget: 2, truncated: false })
  })
})
