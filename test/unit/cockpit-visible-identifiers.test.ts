import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  isOpaqueProse,
  isUuidLike,
  presentValue,
  readableTitle,
  semanticLabel,
  withoutOpaqueRefs,
} from '../../apps/cockpit/src/lib/presentation'

const uuid = '1db97378-8f24-4f95-a5ae-fd5e66535f15'

describe('opaque identifiers at the Cockpit presentation boundary', () => {
  test('recognizes and recursively hides UUID values without mutating the input', () => {
    const input = { id: uuid, title: 'Readable', nested: { source_uuid: uuid, value: uuid }, items: [uuid, 'kept'] }
    const shown = presentValue(input)
    expect(shown).toEqual({
      title: 'Readable',
      nested: { value: 'Internal reference hidden' },
      items: ['Internal reference hidden', 'kept'],
    })
    expect(input.id).toBe(uuid)
    expect(isUuidLike(uuid)).toBe(true)
  })

  test('chooses semantic labels and never falls back to an opaque identifier', () => {
    expect(semanticLabel([null, uuid, 'Readable title'], 'Unnamed')).toBe('Readable title')
    expect(semanticLabel([uuid], 'Unnamed')).toBe('Unnamed')
    expect(semanticLabel([`Create fact-${uuid}`], 'Knowledge change')).toBe('Knowledge change')
  })

  test('does not render known raw identifier fallbacks in end-user views', () => {
    const sources = [
      'apps/cockpit/src/pages/api-keys.tsx',
      'apps/cockpit/src/pages/decisions.tsx',
      'apps/cockpit/src/pages/source.tsx',
      'apps/cockpit/src/pages/identities.tsx',
      'apps/cockpit/src/pages/proposal-review.tsx',
      'apps/cockpit/src/pages/pages.tsx',
      'apps/cockpit/src/pages/search.tsx',
      'apps/cockpit/src/pages/webhooks.tsx',
    ]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(sources).not.toContain('{row.id}\n')
    expect(sources).not.toContain('parent_proposal_id.slice(0, 8)')
    expect(sources).not.toContain('source.title ?? source.id')
    expect(sources).not.toContain('{detail.parent_proposal_id}')
    expect(sources).not.toContain('{citation.source_title ?? citation.source_id}')
    expect(sources).toContain('!isUuidLike(row.event_id)')
  })
})

describe('machine-written titles at the same boundary', () => {
  // The server composes a proposal title from whatever the source was called,
  // and an ingested coding session is called "Codex session <id>". The queue
  // then offered a reviewer a row they could not say out loud, could not search
  // for and could not tell apart from the next one.

  test('recognizes a machine reference in prose, whole or truncated', () => {
    expect(isOpaqueProse(`Ingest: Codex session ${uuid}`)).toBe(true)
    // The truncated form a log line or an ellipsis leaves behind. The strict
    // UUID matcher walks straight past it — and the convention check, which
    // reads the rendered page, does not.
    expect(isOpaqueProse('Ingest: Codex session 01a0103d-9c1f-…')).toBe(true)
    expect(isOpaqueProse('Rückgaberecht: Fristen übernehmen')).toBe(false)
  })

  test('removes the reference and the clause it leaves dangling', () => {
    expect(withoutOpaqueRefs(`Synthesized 8 concepts, 28 claims from source ${uuid}.`)).toBe(
      'Synthesized 8 concepts, 28 claims',
    )
    expect(withoutOpaqueRefs(`Ingest: Codex session ${uuid}`)).toBe('Ingest: Codex session')
  })

  test('leaves prose that names no machine reference exactly as it was', () => {
    const untouched = 'Eskalationsweg für Zahlungsausfälle beschreiben'
    expect(withoutOpaqueRefs(untouched)).toBe(untouched)
    expect(readableTitle(untouched, 'Fallback')).toEqual({ text: untouched, redacted: false })
  })

  test('keeps the words and reports that a date is owed', () => {
    // `redacted` is what makes the caller append the date: "Codex session"
    // alone would make every session look like the same one.
    expect(readableTitle(`Ingest: Codex session ${uuid}`, 'Fallback')).toEqual({
      text: 'Ingest: Codex session',
      redacted: true,
    })
  })

  test('a title that was ONLY an identifier falls back rather than showing a stub', () => {
    expect(readableTitle(uuid, 'Wissensänderung')).toEqual({ text: 'Wissensänderung', redacted: true })
    expect(readableTitle('', 'Wissensänderung')).toEqual({ text: 'Wissensänderung', redacted: false })
    expect(readableTitle(null, 'Wissensänderung').text).toBe('Wissensänderung')
  })

  test('answers the same way twice — the matcher carries no state between calls', () => {
    // A single /g regex would keep `lastIndex` between a replace and a test and
    // answer differently on the second row.
    const title = `Ingest: Codex session ${uuid}`
    expect(isOpaqueProse(title)).toBe(isOpaqueProse(title))
    expect(withoutOpaqueRefs(title)).toBe(withoutOpaqueRefs(title))
  })

  test('the queue and the overview both run their titles through it', () => {
    const decisions = readFileSync('apps/cockpit/src/pages/decisions.tsx', 'utf8')
    const home = readFileSync('apps/cockpit/src/pages/home.tsx', 'utf8')
    for (const [name, source] of [
      ['decisions.tsx', decisions],
      ['home.tsx', home],
    ] as const) {
      expect(source, `${name} renders titles without the presentation boundary`).toContain('readableTitle(')
      // Summaries reach the same stripper through `summaryLine`, which derives
      // the German line and falls back to the cleaned original.
      expect(source, `${name} renders summaries without the presentation boundary`).toContain('summaryLine(')
    }
    // The raw title is not deleted, it moves: evidence about where a position
    // came from belongs in the detail depth, not in the name.
    expect(decisions).toContain('decisions.rawTitle')
  })
})
