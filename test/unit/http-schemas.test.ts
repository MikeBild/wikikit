// Wire-schema behavior pinned at the boundary: these shapes are the REST
// contract (§5.3) — a change that breaks one of these tests is an API change.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  SCHEMAS,
  zCreateApiKeyRequest,
  zCreateProposalRequest,
  zErrorEnvelope,
  zIngestRequest,
  zListQuery,
  zQueryRequest,
  zReadyResponse,
  zReviewRequest,
  zSearchQuery,
} from '../../src/http/schemas.ts'

describe('http schemas', () => {
  test('zIngestRequest requires exactly one of markdown|text|url', () => {
    expect(zIngestRequest.safeParse({ markdown: '# hi' }).success).toBe(true)
    expect(zIngestRequest.safeParse({ text: 'hi' }).success).toBe(true)
    expect(zIngestRequest.safeParse({ url: 'https://example.com/a' }).success).toBe(true)
    expect(zIngestRequest.safeParse({}).success).toBe(false)
    expect(zIngestRequest.safeParse({ markdown: '# hi', text: 'hi' }).success).toBe(false)
    expect(zIngestRequest.safeParse({ url: 'not-a-url' }).success).toBe(false)
  })

  test('zReviewRequest defaults an absent body to {}', () => {
    expect(zReviewRequest.parse(undefined)).toEqual({})
    expect(zReviewRequest.parse({ note: 'lgtm' })).toEqual({ note: 'lgtm' })
    expect(zReviewRequest.safeParse({ note: 'x'.repeat(2001) }).success).toBe(false)
  })

  test('query schemas coerce numeric strings (query values arrive as strings)', () => {
    expect(zListQuery.parse({ limit: '25' })).toEqual({ limit: 25 })
    expect(zListQuery.safeParse({ limit: '0' }).success).toBe(false)
    expect(zSearchQuery.parse({ q: 'foo', limit: '5' })).toEqual({ q: 'foo', limit: 5 })
    expect(zSearchQuery.safeParse({ q: '' }).success).toBe(false)
  })

  test('zQueryRequest applies the top_k default and caps it', () => {
    expect(zQueryRequest.parse({ question: 'why?' })).toEqual({ question: 'why?', top_k: 8 })
    expect(zQueryRequest.safeParse({ question: 'why?', top_k: 51 }).success).toBe(false)
  })

  test('zErrorEnvelope is loose: conflict envelopes carry extra fields (source_id)', () => {
    const parsed = zErrorEnvelope.parse({
      error: 'content already ingested',
      code: 'already_ingested',
      request_id: 'a1b2c3d4e5f6',
      source_id: '00000000-0000-0000-0000-000000000001',
    })
    expect((parsed as Record<string, unknown>).source_id).toBe('00000000-0000-0000-0000-000000000001')
  })

  test('zCreateApiKeyRequest rejects unknown scopes and empty scope lists', () => {
    expect(zCreateApiKeyRequest.safeParse({ name: 'k', scopes: ['knowledge:read'] }).success).toBe(true)
    expect(zCreateApiKeyRequest.safeParse({ name: 'k', scopes: [] }).success).toBe(false)
    expect(zCreateApiKeyRequest.safeParse({ name: 'k', scopes: ['*'] }).success).toBe(false) // '*' is bootstrap-only
    expect(zCreateApiKeyRequest.safeParse({ name: 'k', scopes: ['root'] }).success).toBe(false)
  })

  test('zCreateProposalRequest accepts removal-only proposals and rejects contradictory edges', () => {
    const base = { title: 'Prune legacy links', input_hash: 'a'.repeat(64) }
    const edge = { from_slug: 'okf', to_slug: 'legacy-store', kind: 'depends_on' }

    // A removal-only proposal is valid — no fake revision required.
    expect(zCreateProposalRequest.safeParse({ ...base, relations_removed: [edge] }).success).toBe(true)
    // Empty everything still fails the at-least-one refine.
    expect(zCreateProposalRequest.safeParse(base).success).toBe(false)
    // Slug pattern and kind enum hold at the boundary.
    expect(
      zCreateProposalRequest.safeParse({ ...base, relations_removed: [{ ...edge, from_slug: 'Bad Slug' }] }).success,
    ).toBe(false)
    expect(
      zCreateProposalRequest.safeParse({ ...base, relations_removed: [{ ...edge, kind: 'unrelated' }] }).success,
    ).toBe(false)
    // Duplicate edges are refused.
    expect(zCreateProposalRequest.safeParse({ ...base, relations_removed: [edge, { ...edge }] }).success).toBe(false)
    // The same edge added AND removed in one proposal is contradictory.
    expect(
      zCreateProposalRequest.safeParse({
        ...base,
        concepts: [
          {
            slug: 'okf',
            title: 'OKF',
            markdown: '# OKF',
            relations: [{ to_slug: 'legacy-store', kind: 'depends_on' }],
          },
        ],
        relations_removed: [edge],
      }).success,
    ).toBe(false)
  })

  test('zReadyResponse pins the exact deploy-gate shape', () => {
    expect(zReadyResponse.parse({ status: 'ready', version: '0.1.0' })).toEqual({ status: 'ready', version: '0.1.0' })
    expect(zReadyResponse.safeParse({ status: 'ok', version: '0.1.0' }).success).toBe(false)
  })

  test('every schema in the index parses without throwing on introspection', () => {
    // Guards the OpenAPI path: z.toJSONSchema must be able to render each one.
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      expect(() => z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }), name).not.toThrow()
    }
  })
})
