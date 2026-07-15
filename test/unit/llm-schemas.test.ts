// LLM output schema tests: zod acceptance/rejection semantics plus the
// structured-outputs JSON schema projection (additionalProperties:false
// everywhere, no keywords the grammar compiler rejects). The fixtures under
// test/fixtures/llm/ double as the canned bodies for provider tests, so
// validating them here guarantees every canned response is contract-valid.
import { describe, expect, test } from 'bun:test'
import {
  toOutputJsonSchema,
  zAdjudicateOutput,
  zAnswerOutput,
  zClassifyOutput,
  zSynthesizeOutput,
} from '../../src/llm/schemas.ts'
import { loadLlmFixture } from '../helpers/fake-provider.ts'

describe('fixtures are schema-valid', () => {
  test('classify.output.json', () => {
    expect(zClassifyOutput.safeParse(loadLlmFixture('classify.output.json')).success).toBe(true)
  })
  test('synthesize.output.json', () => {
    expect(zSynthesizeOutput.safeParse(loadLlmFixture('synthesize.output.json')).success).toBe(true)
  })
  test('answer.output.json', () => {
    expect(zAnswerOutput.safeParse(loadLlmFixture('answer.output.json')).success).toBe(true)
  })
  test('adjudicate.output.json', () => {
    expect(zAdjudicateOutput.safeParse(loadLlmFixture('adjudicate.output.json')).success).toBe(true)
  })
})

describe('rejection semantics (no silent partials)', () => {
  test('classify rejects slugs that violate the DB slug constraint', () => {
    expect(zClassifyOutput.safeParse({ affected: ['Not A Slug!'], new: [] }).success).toBe(false)
    expect(zClassifyOutput.safeParse({ affected: [], new: [{ slug: '-leading-hyphen', title: 'x' }] }).success).toBe(
      false,
    )
  })

  test('synthesize rejects confidence outside [0,1]', () => {
    const base = loadLlmFixture<Record<string, unknown>>('synthesize.output.json')
    const claims = structuredClone(base.claims) as { confidence: number }[]
    claims[0]!.confidence = 1.5
    expect(zSynthesizeOutput.safeParse({ ...base, claims }).success).toBe(false)
  })

  test('synthesize rejects claims without a quote', () => {
    const base = loadLlmFixture<Record<string, unknown>>('synthesize.output.json')
    const claims = structuredClone(base.claims) as { quote: string }[]
    claims[0]!.quote = ''
    expect(zSynthesizeOutput.safeParse({ ...base, claims }).success).toBe(false)
  })

  test('synthesize rejects unknown relation kinds', () => {
    const base = loadLlmFixture<Record<string, unknown>>('synthesize.output.json')
    expect(zSynthesizeOutput.safeParse({ ...base, relations: [{ to_slug: 'x', kind: 'loves' }] }).success).toBe(false)
  })

  test('answer rejects a missing not_in_knowledge_base flag', () => {
    expect(zAnswerOutput.safeParse({ answer_markdown: 'x', cited_slugs: [] }).success).toBe(false)
  })

  test('adjudicate rejects unknown verdicts', () => {
    expect(zAdjudicateOutput.safeParse({ verdict: 'maybe', reason: 'x' }).success).toBe(false)
  })
})

describe('toOutputJsonSchema (structured outputs wire schema)', () => {
  const UNSUPPORTED = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'minItems',
    'maxItems',
  ]

  function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, visit))
    if (node === null || typeof node !== 'object') return
    visit(node as Record<string, unknown>)
    for (const value of Object.values(node)) walk(value, visit)
  }

  for (const [name, schema] of [
    ['zClassifyOutput', zClassifyOutput],
    ['zSynthesizeOutput', zSynthesizeOutput],
    ['zAnswerOutput', zAnswerOutput],
    ['zAdjudicateOutput', zAdjudicateOutput],
  ] as const) {
    test(`${name}: closed objects, no unsupported keywords, no $schema envelope`, () => {
      const json = toOutputJsonSchema(schema)
      expect(json.$schema).toBeUndefined()
      expect(json.type).toBe('object')
      walk(json, (obj) => {
        if (obj.type === 'object') {
          expect(obj.additionalProperties).toBe(false)
          // every property must be required — structured outputs cannot
          // express optionality, and our output contracts have none
          expect(Object.keys((obj.properties as Record<string, unknown>) ?? {}).sort()).toEqual(
            ([...((obj.required as string[]) ?? [])] as string[]).sort(),
          )
        }
        for (const keyword of UNSUPPORTED) expect(obj[keyword]).toBeUndefined()
      })
    })
  }

  test('stripped constraints are still enforced client-side by zod', () => {
    // The wire schema drops minimum/maximum for confidence — the zod parse
    // after the response is what still rejects 1.5 (tested above). This test
    // documents the pairing: wire schema is permissive, zod is not.
    const json = toOutputJsonSchema(zSynthesizeOutput) as {
      properties: { claims: { items: { properties: { confidence: Record<string, unknown> } } } }
    }
    expect(json.properties.claims.items.properties.confidence).toEqual({ type: 'number' })
  })
})
