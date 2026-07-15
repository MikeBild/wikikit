// chunk.ts — token estimation, heading-aligned splitting and budget packing.
// The budget is what stands between a 5 MB source and a 5 MB prompt, so the
// edge cases (fenced headings, structureless walls of text, tiny budgets) are
// tested explicitly.
import { describe, expect, test } from 'bun:test'
import { estimateTokens, fitTokenBudget, splitMarkdown } from '../../src/ingest/chunk.ts'

describe('estimateTokens', () => {
  test('ceil(chars / 4), deterministic', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('x'.repeat(400))).toBe(100)
  })
})

describe('splitMarkdown', () => {
  test('splits preamble and one chunk per ATX heading section', () => {
    const chunks = splitMarkdown('intro line\n\n# One\n\nbody one\n\n## Two\n\nbody two')
    expect(chunks.map((chunk) => chunk.heading)).toEqual([null, '# One', '## Two'])
    expect(chunks[1]!.text).toContain('body one')
    expect(chunks[2]!.text).toContain('body two')
  })

  test('a # inside a fenced code block does not start a chunk', () => {
    const markdown = '# Top\n\n```bash\n# this is a comment, not a heading\necho hi\n```\n\ntail'
    const chunks = splitMarkdown(markdown)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.text).toContain('# this is a comment')
  })

  test('whitespace-only documents produce no chunks', () => {
    expect(splitMarkdown('  \n\n  ')).toEqual([])
  })
})

describe('fitTokenBudget', () => {
  const doc = [
    '# Title',
    '',
    'Intro paragraph.',
    '',
    '## Alpha',
    '',
    'A'.repeat(400),
    '',
    '## Beta',
    '',
    'B'.repeat(400),
  ].join('\n')

  test('returns the document unchanged when it fits', () => {
    const result = fitTokenBudget(doc, 100_000)
    expect(result.markdown).toBe(doc)
    expect(result.truncated).toBe(false)
    expect(result.tokens).toBe(estimateTokens(doc))
  })

  test('keeps whole front sections and drops the tail when over budget', () => {
    const result = fitTokenBudget(doc, 160)
    expect(result.truncated).toBe(true)
    expect(result.markdown).toContain('# Title')
    expect(result.markdown).toContain('## Alpha')
    expect(result.markdown).not.toContain('## Beta')
    // The model is told content is missing — never a silent cut.
    expect(result.markdown).toContain('truncated')
    expect(result.tokens).toBeLessThanOrEqual(160)
  })

  test('descends into paragraphs when a single section overflows', () => {
    const big = `## Only\n\nfirst para.\n\n${'C'.repeat(2000)}`
    const result = fitTokenBudget(big, 60)
    expect(result.truncated).toBe(true)
    expect(result.markdown).toContain('first para.')
    expect(result.markdown).not.toContain('CCCC')
  })

  test('hard-slices a structureless wall of text instead of returning nothing', () => {
    const wall = 'D'.repeat(4000) // one paragraph, no headings, ~1000 tokens
    const result = fitTokenBudget(wall, 50)
    expect(result.truncated).toBe(true)
    expect(result.markdown).toContain('DDDD')
    expect(result.tokens).toBeLessThanOrEqual(50)
  })

  test('is idempotent — refitting the fitted output changes nothing', () => {
    const once = fitTokenBudget(doc, 160)
    const twice = fitTokenBudget(once.markdown, 160)
    expect(twice.markdown).toBe(once.markdown)
    expect(twice.truncated).toBe(false)
  })

  test('rejects a non-positive budget', () => {
    expect(() => fitTokenBudget('x', 0)).toThrow()
  })
})
