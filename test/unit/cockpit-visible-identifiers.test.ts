import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isUuidLike, presentValue, semanticLabel } from '../../apps/cockpit/src/lib/presentation'

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
      'apps/cockpit/src/pages/changes.tsx',
      'apps/cockpit/src/pages/source.tsx',
      'apps/cockpit/src/pages/identities.tsx',
      'apps/cockpit/src/pages/change.tsx',
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
