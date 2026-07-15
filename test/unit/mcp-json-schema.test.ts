// zodToJsonSchema7 — the manifest emitter's shape guarantees (CONTRACTS §7):
// draft-7 compatible, additionalProperties:false on every plain object, no
// dialect marker, defaulted fields NOT listed as required (input semantics).
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { zodToJsonSchema7 } from '../../src/mcp/json-schema.ts'

describe('zodToJsonSchema7', () => {
  test('emits closed objects without a $schema marker', () => {
    const schema = zodToJsonSchema7(z.object({ q: z.string().min(1) }))
    expect(schema.$schema).toBeUndefined()
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['q'])
  })

  test('defaulted and optional fields are not required (input semantics)', () => {
    const schema = zodToJsonSchema7(
      z.object({
        q: z.string(),
        limit: z.number().int().optional(),
        summary: z.string().default(''),
      }),
    )
    expect(schema.required).toEqual(['q'])
    const properties = schema.properties as Record<string, Record<string, unknown>>
    // The default value survives as documentation for the client.
    expect(properties.summary!.default).toBe('')
  })

  test('closes nested objects (arrays of objects included)', () => {
    const schema = zodToJsonSchema7(
      z.object({
        concepts: z.array(z.object({ slug: z.string(), claims: z.array(z.object({ subject: z.string() })) })),
      }),
    )
    const concepts = (schema.properties as Record<string, Record<string, unknown>>).concepts!
    const item = concepts.items as Record<string, unknown>
    expect(item.additionalProperties).toBe(false)
    const claims = (item.properties as Record<string, Record<string, unknown>>).claims!
    expect((claims.items as Record<string, unknown>).additionalProperties).toBe(false)
  })

  test('records keep their value schema in additionalProperties (never clobbered to false)', () => {
    const schema = zodToJsonSchema7(z.object({ agent_meta: z.record(z.string(), z.unknown()) }))
    const meta = (schema.properties as Record<string, Record<string, unknown>>).agent_meta!
    expect(meta.additionalProperties).not.toBe(false)
    // The record's key annotation is collapsed away (draft-7 native shape).
    expect(meta.propertyNames).toBeUndefined()
  })

  test('refined schemas (cross-field rules) still emit their object shape', () => {
    const schema = zodToJsonSchema7(
      z
        .object({ markdown: z.string().optional(), url: z.string().optional() })
        .refine((v) => [v.markdown, v.url].filter(Boolean).length === 1),
    )
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties as object)).toEqual(['markdown', 'url'])
  })
})
