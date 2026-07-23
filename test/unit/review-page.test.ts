// Review page (0020): the pure line-diff algorithm (stringified verbatim
// into the page — these tests cover exactly what reviewers see), plus the
// self-containment guarantees of the shell.
import { describe, expect, test } from 'bun:test'
import { lineDiff, renderReviewPage, REVIEW_PAGE_CSP } from '../../src/http/review-page.ts'

describe('lineDiff', () => {
  test('identical documents are pure context', () => {
    const ops = lineDiff('a\nb\nc', 'a\nb\nc')!
    expect(ops.every((entry) => entry.op === ' ')).toBe(true)
    expect(ops).toHaveLength(3)
  })

  test('classic edit: change one line, keep surroundings as context', () => {
    const ops = lineDiff('title\nold line\nfooter', 'title\nnew line\nfooter')!
    expect(ops).toEqual([
      { op: ' ', text: 'title' },
      { op: '-', text: 'old line' },
      { op: '+', text: 'new line' },
      { op: ' ', text: 'footer' },
    ])
  })

  test('pure additions and pure removals', () => {
    expect(lineDiff('', 'a\nb')).toEqual([
      { op: '-', text: '' },
      { op: '+', text: 'a' },
      { op: '+', text: 'b' },
    ])
    expect(lineDiff('a\nb', 'a')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
    ])
  })

  test('reconstructing both sides from the ops loses nothing', () => {
    const oldText = '# Page\n\nalpha\nbeta\ngamma'
    const newText = '# Page\n\nalpha\nBETA\ngamma\ndelta'
    const ops = lineDiff(oldText, newText)!
    const oldBack = ops
      .filter((entry) => entry.op !== '+')
      .map((entry) => entry.text)
      .join('\n')
    const newBack = ops
      .filter((entry) => entry.op !== '-')
      .map((entry) => entry.text)
      .join('\n')
    expect(oldBack).toBe(oldText)
    expect(newBack).toBe(newText)
  })

  test('size guard returns null instead of an O(n·m) blowup', () => {
    const big = Array.from({ length: 3001 }, (_, i) => `line ${i}`).join('\n')
    expect(lineDiff(big, 'x')).toBeNull()
    expect(lineDiff('x', big)).toBeNull()
  })
})

describe('renderReviewPage self-containment', () => {
  const html = renderReviewPage('11111111-1111-4111-8111-111111111111')

  test('CSP stays byte-identical (no external assets ever)', () => {
    expect(REVIEW_PAGE_CSP).toContain("default-src 'none'")
    expect(REVIEW_PAGE_CSP).toContain("connect-src 'self'")
  })

  test('the page embeds the SAME lineDiff implementation the tests cover', () => {
    expect(html).toContain('const lineDiff = ')
    expect(html).toContain(lineDiff.toString().slice(0, 60))
  })

  test('no external URLs anywhere in the document', () => {
    expect(html).not.toMatch(/src="http/)
    expect(html).not.toMatch(/href="http/)
  })

  test('review operations are wired: defer, request-changes, approve, reject', () => {
    for (const marker of ['request-changes', '/split', 'button.defer', 'knowledge:approve', 'knowledge:review']) {
      expect(html).toContain(marker)
    }
  })
})
