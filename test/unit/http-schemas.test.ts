// Wire-schema behavior pinned at the boundary: these shapes are the REST
// contract (§5.3) — a change that breaks one of these tests is an API change.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  SCHEMAS,
  zCreateApiKeyRequest,
  zCreateProposalRequest,
  zCreateSpaceRequest,
  zErrorEnvelope,
  zIngestRequest,
  zListQuery,
  zQueryRequest,
  zReadyResponse,
  zReviewRequest,
  zSearchQuery,
  zSearchResponse,
  zUpdateSpaceSettingsRequest,
  zUpsertIdentityRequest,
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

  test('search hits carry matched_via when the hybrid ranker answered, and omit it otherwise', () => {
    // The three values are produced by the fusion CASE in 0018/0040/0041; the
    // wire may not invent a fourth. Absence is meaningful: a deployment
    // without pgvector or without an embedding provider ran one arm, and
    // naming it would imply a choice was made between two.
    const hit = {
      kind: 'concept',
      tier: 'approved',
      slug: 'wikikit',
      claim_id: null,
      title: 'WikiKit',
      headline: '<mark>WikiKit</mark>',
      rank: 0.42,
      source_id: null,
      chunk_id: null,
      url: null,
      heading: null,
      space: 'demo',
    }
    const response = (matched_via?: string) => ({
      hits: [matched_via === undefined ? hit : { ...hit, matched_via }],
      searched_spaces: ['demo'],
    })

    expect(zSearchResponse.safeParse(response()).success).toBe(true)
    for (const value of ['lexical', 'vector', 'both']) {
      expect(zSearchResponse.safeParse(response(value)).success).toBe(true)
    }
    expect(zSearchResponse.safeParse(response('hybrid')).success).toBe(false)
    expect(zSearchResponse.safeParse(response('')).success).toBe(false)

    const parsed = zSearchResponse.parse(response('both'))
    expect(parsed.hits[0]!.matched_via).toBe('both')
    expect(zSearchResponse.parse(response()).hits[0]!.matched_via).toBeUndefined()
  })

  test('space settings validate the retrieval-critical language key, stay free-form otherwise', () => {
    // Must match the CHECK/CASE lists in migration 0016 (wk_space_search_config).
    expect(zUpdateSpaceSettingsRequest.safeParse({ settings: { language: 'de' } }).success).toBe(true)
    expect(zUpdateSpaceSettingsRequest.safeParse({ settings: { language: 'simple' } }).success).toBe(true)
    expect(zUpdateSpaceSettingsRequest.safeParse({ settings: { language: 'fr' } }).success).toBe(false)
    expect(zUpdateSpaceSettingsRequest.safeParse({ settings: { language: 42 } }).success).toBe(false)
    expect(zUpdateSpaceSettingsRequest.safeParse({ settings: { anything: { nested: true } } }).success).toBe(true)
    expect(zCreateSpaceRequest.safeParse({ slug: 'blog-de', name: 'Blog', settings: { language: 'xx' } }).success).toBe(
      false,
    )
    expect(zCreateSpaceRequest.safeParse({ slug: 'blog-de', name: 'Blog', settings: { language: 'de' } }).success).toBe(
      true,
    )
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

  test('zUpsertIdentityRequest tells "keep it", "clear it" and "set it" apart on email', () => {
    // Three states on one nullable column. The update path COALESCEs nothing
    // for email precisely so these stay distinguishable: absence is the
    // console instructing the server to keep the stored address, and without a
    // clearing spelling an operator removing a stale one changed nothing.
    expect('email' in zUpsertIdentityRequest.parse({ role: 'reader' })).toBe(false)
    expect(zUpsertIdentityRequest.parse({ email: null }).email).toBeNull()
    expect(zUpsertIdentityRequest.parse({ email: 'alex@example.com' }).email).toBe('alex@example.com')

    // '' is refused rather than accepted as a third empty: NULL is what this
    // column already means "no email" with (the SSO callback writes it), and
    // one nullable column holding two kinds of empty is a distinction every
    // reader downstream would have to carry.
    expect(zUpsertIdentityRequest.safeParse({ email: '' }).success).toBe(false)
    expect(zUpsertIdentityRequest.safeParse({ email: `${'a'.repeat(311)}@example.com` }).success).toBe(false)

    // display_name keeps the opposite spelling on purpose — the column is
    // `not null default ''`, so '' IS its empty and null is not a value it
    // can hold.
    expect(zUpsertIdentityRequest.parse({ display_name: '' }).display_name).toBe('')
    expect(zUpsertIdentityRequest.safeParse({ display_name: null }).success).toBe(false)
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

describe('zCreateApiKeyRequest — role presets (0-migration)', () => {
  test('exactly one of role or scopes', () => {
    expect(zCreateApiKeyRequest.safeParse({ name: 'k', role: 'reviewer' }).success).toBe(true)
    expect(zCreateApiKeyRequest.safeParse({ name: 'k', scopes: ['knowledge:read'] }).success).toBe(true)
    expect(zCreateApiKeyRequest.safeParse({ name: 'k' }).success).toBe(false)
    expect(zCreateApiKeyRequest.safeParse({ name: 'k', role: 'reader', scopes: ['knowledge:read'] }).success).toBe(
      false,
    )
    // No approver preset — knowledge:approve must be spelled out.
    expect(zCreateApiKeyRequest.safeParse({ name: 'k', role: 'approver' }).success).toBe(false)
  })
})
