// Charter pure functions — the render/parse round-trip that makes the virtual
// document bidirectional. No DB: these are pure functions of their input.
import { describe, expect, test } from 'bun:test'
import {
  CHARTER_CLOSE,
  CHARTER_OPEN,
  OVERVIEW_CLOSE,
  OVERVIEW_OPEN,
  parseCharterDocument,
  renderCharter,
  renderOverview,
  toCharterResponse,
  type CharterDetail,
} from '../../src/domain/charter.ts'

const overview = {
  concepts: 2,
  decisions: 1,
  sources: 3,
  index: [
    { slug: 'wikikit', summary: 'Headless knowledge system.' },
    { slug: 'open-knowledge-format', summary: 'An open bundle format.' },
  ],
}

const detail: CharterDetail = {
  space: 'demo',
  space_name: 'Demo Space',
  rev: 2,
  markdown: '# Charter\n\nPrioritise decisions with rationale. Voice: terse.',
  updated_at: '2026-07-24T12:00:00.000Z',
  overview,
}

describe('renderOverview', () => {
  test('lists counts and a concept index with wiki-links', () => {
    const rendered = renderOverview(overview)
    expect(rendered).toContain('- Concepts: 2')
    expect(rendered).toContain('- Decisions: 1')
    expect(rendered).toContain('- Sources: 3')
    expect(rendered).toContain('- [[wikikit]] — Headless knowledge system.')
  })

  test('is a pure function of its input', () => {
    expect(renderOverview(overview)).toBe(renderOverview(overview))
  })

  test('omits the concept index when the space has no concepts', () => {
    expect(renderOverview({ concepts: 0, decisions: 0, sources: 0, index: [] })).not.toContain('Concept index')
  })
})

describe('renderCharter', () => {
  const doc = renderCharter(detail)

  test('assembles heading, authored text between charter markers, and derived overview', () => {
    expect(doc).toContain('# Demo Space — Charter')
    expect(doc).toContain(CHARTER_OPEN)
    expect(doc).toContain(CHARTER_CLOSE)
    expect(doc).toContain('Prioritise decisions with rationale.')
    expect(doc).toContain('## Overview (derived)')
    expect(doc).toContain(OVERVIEW_OPEN)
    expect(doc).toContain(OVERVIEW_CLOSE)
    expect(doc).toContain('- [[wikikit]] — Headless knowledge system.')
  })

  test('a never-written charter shows a placeholder, not empty markers', () => {
    const empty = renderCharter({ ...detail, rev: null, markdown: '', updated_at: null })
    expect(empty).toContain('No charter written yet')
  })
})

describe('parseCharterDocument', () => {
  test('round-trips the authored half of a full rendered document verbatim', () => {
    const doc = renderCharter(detail)
    const parsed = parseCharterDocument(doc)
    expect(parsed.authored).toBe(detail.markdown.trim())
    // The overview block is captured too (so a write can detect an edit).
    expect(parsed.overview).toContain('- Concepts: 2')
  })

  test('a body without markers is taken wholesale as the authored charter', () => {
    const raw = '# My charter\n\nJust write markdown directly.'
    const parsed = parseCharterDocument(raw)
    expect(parsed.authored).toBe(raw)
    expect(parsed.overview).toBeNull()
  })

  test('extracts an edited overview block distinctly from the authored text', () => {
    const body = [
      CHARTER_OPEN,
      'Authored guidance.',
      CHARTER_CLOSE,
      OVERVIEW_OPEN,
      '- Concepts: 2\n- Decisions: 1\n\nHand-added: rename wikikit → wiki-kit',
      OVERVIEW_CLOSE,
    ].join('\n')
    const parsed = parseCharterDocument(body)
    expect(parsed.authored).toBe('Authored guidance.')
    expect(parsed.overview).toContain('rename wikikit → wiki-kit')
  })
})

describe('toCharterResponse', () => {
  test('is the shared wire projection (fields + rendered document)', () => {
    const wire = toCharterResponse(detail)
    expect(wire).toMatchObject({
      space: 'demo',
      rev: 2,
      markdown: detail.markdown,
      updated_at: detail.updated_at,
      overview,
    })
    expect(typeof wire.document).toBe('string')
    expect(wire.document).toBe(renderCharter(detail))
  })
})
