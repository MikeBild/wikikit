// markdown module — frontmatter round-trip (the lossless export/import
// anchor), canonical normalization (the content-hash stability anchor), HTML
// projection and structural probes.
import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../../src/domain/errors.ts'
import {
  extractTitle,
  extractWikiLinks,
  htmlToMarkdown,
  normalizeMarkdown,
  parseFrontmatter,
  serializeFrontmatter,
} from '../../src/markdown.ts'

describe('parseFrontmatter', () => {
  test('splits yaml frontmatter from the body verbatim', () => {
    const parsed = parseFrontmatter('---\ntitle: OKF\ntags:\n  - spec\n---\n\n# Body\n\nText.\n')
    expect(parsed.data).toEqual({ title: 'OKF', tags: ['spec'] })
    expect(parsed.content).toBe('\n# Body\n\nText.\n')
  })

  test('document without frontmatter passes through untouched', () => {
    const parsed = parseFrontmatter('# Just a heading\n')
    expect(parsed.data).toEqual({})
    expect(parsed.content).toBe('# Just a heading\n')
  })

  test('a thematic break mid-document is NOT frontmatter', () => {
    const markdown = 'intro\n\n---\n\nmore\n'
    expect(parseFrontmatter(markdown).content).toBe(markdown)
  })

  test('unterminated frontmatter fails loudly', () => {
    expect(() => parseFrontmatter('---\ntitle: x\nno terminator')).toThrow(ValidationError)
  })

  test('invalid YAML and non-object frontmatter fail loudly (never silently dropped)', () => {
    expect(() => parseFrontmatter('---\n"[broken\n---\nbody')).toThrow(ValidationError)
    expect(() => parseFrontmatter('---\n- a\n- b\n---\nbody')).toThrow(ValidationError)
  })
})

describe('serializeFrontmatter — round-trip contract', () => {
  test('parse(serialize(data, content)).content === content', () => {
    const data = {
      title: 'OKF',
      claims: [{ subject: 'okf', predicate: 'has_status', object: 'draft-v0.1', confidence: 0.9 }],
    }
    const content = '# OKF\n\nBody text with [[subkit]].\n'
    const document = serializeFrontmatter(data, content)
    const parsed = parseFrontmatter(document)
    expect(parsed.content).toBe(content)
    expect(parsed.data).toEqual(data)
    // Byte-stable second pass — the export → import → export contract.
    expect(serializeFrontmatter(parsed.data, parsed.content)).toBe(document)
  })

  test('empty data emits no fence', () => {
    expect(serializeFrontmatter({}, '# Body\n')).toBe('# Body\n')
  })
})

describe('normalizeMarkdown — canonical formatting', () => {
  test('canonicalizes list bullets and emphasis markers', () => {
    const normalized = normalizeMarkdown('* one\n* two\n\nsome __bold__ and _em_\n')
    expect(normalized).toContain('- one')
    expect(normalized).toContain('**bold**')
    expect(normalized).toContain('*em*')
  })

  test('is idempotent (required: normalized output is what gets hashed)', () => {
    const once = normalizeMarkdown('# T\n\n* a\n* b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(normalizeMarkdown(once)).toBe(once)
  })

  test('preserves frontmatter as a yaml block', () => {
    const normalized = normalizeMarkdown('---\ntitle: X\n---\n\n* item\n')
    expect(normalized.startsWith('---\ntitle: X\n---\n')).toBe(true)
    expect(normalized).toContain('- item')
  })
})

describe('htmlToMarkdown', () => {
  test('projects readable content and drops scripts/styles', () => {
    const markdown = htmlToMarkdown(
      '<html><head><style>.x{}</style></head><body>' +
        '<h1>Title</h1><p>Para with <strong>bold</strong> and <a href="https://example.com">a link</a>.</p>' +
        '<script>alert(1)</script><ul><li>one</li><li>two</li></ul></body></html>',
    )
    expect(markdown).toContain('# Title')
    expect(markdown).toContain('**bold**')
    expect(markdown).toContain('[a link](https://example.com)')
    expect(markdown).toContain('- one')
    expect(markdown).not.toContain('alert(1)')
    expect(markdown).not.toContain('.x{}')
  })
})

describe('extractWikiLinks', () => {
  test('collects well-formed slugs, deduplicated in first-appearance order', () => {
    expect(extractWikiLinks('See [[okf]] and [[subkit]] — also [[okf]] again.')).toEqual(['okf', 'subkit'])
  })

  test('ignores malformed link targets (prose, not links)', () => {
    expect(extractWikiLinks('[[Not A Slug]] [[-leading-dash]] [[UPPER]] [[]]')).toEqual([])
  })
})

describe('extractTitle', () => {
  test('prefers frontmatter title over the first heading', () => {
    expect(extractTitle('---\ntitle: From Frontmatter\n---\n# From Heading\n')).toBe('From Frontmatter')
  })

  test('falls back to the first ATX h1', () => {
    expect(extractTitle('intro text\n\n# The Heading ##\n\n## sub\n')).toBe('The Heading')
  })

  test('null when neither exists', () => {
    expect(extractTitle('just prose\n')).toBeNull()
  })
})
