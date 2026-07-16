// MCP manifest contract (plan §14.2): the FULL tools/list manifest — names,
// descriptions, draft-7 input schemas, all four annotations — snapshotted PER
// SCOPE. Federated clients (Claude Code, claude.ai, any MCP federation)
// build against exactly these shapes; a diff in the snapshot file is a
// visible, deliberate API change that requires a snapshot commit.
//
// Plus the protocol handshake pin: the transport guard must accept every
// version in the SDK's SUPPORTED_PROTOCOL_VERSIONS — an SDK upgrade that
// drops a version breaks deployed clients, and this test makes that a
// reviewable diff instead of a silent behavior change.
import { describe, expect, test } from 'bun:test'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { zConceptResponse } from '../../src/http/schemas.ts'
import type { IngestPipeline } from '../../src/ingest/pipeline.ts'
import { buildToolManifest, TOOLS, type Principal, type ToolDeps } from '../../src/mcp/tools.ts'
import { validateMcpRequest } from '../../src/mcp/server.ts'

describe('MCP manifest contract', () => {
  // One snapshot per key type an operator can mint (§1.10 scopes). The
  // read+propose pair is the palette a personal-agent key sees (plan §13.A);
  // approve alone must see an EMPTY palette — approval is REST-only.
  const SCOPE_SETS: Record<string, string[]> = {
    'read-key': ['knowledge:read'],
    'propose-key': ['knowledge:propose'],
    'read-propose-key': ['knowledge:read', 'knowledge:propose'],
    'approve-only-key': ['knowledge:approve'],
    'admin-key': ['admin'],
    'star-key': ['*'],
  }

  for (const [label, scopes] of Object.entries(SCOPE_SETS)) {
    test(`tools/list manifest for ${label}`, () => {
      expect(buildToolManifest(scopes)).toMatchSnapshot()
    })
  }

  test('the full palette is exactly the nine §7.1 tools — no approve tool ever', () => {
    const names = buildToolManifest(['*']).map((entry) => entry.name)
    expect(names).toEqual([
      'wikikit_search',
      'wikikit_read',
      'wikikit_sources',
      'wikikit_decisions',
      'wikikit_history',
      'wikikit_lint',
      'wikikit_ingest',
      'wikikit_ingest_status',
      'wikikit_propose',
    ])
  })

  test('protocol handshake: every SDK-supported version passes the transport guard', () => {
    const config = { publicUrl: 'http://127.0.0.1:4060' } as Config
    expect(SUPPORTED_PROTOCOL_VERSIONS.length).toBeGreaterThan(0)
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const request = new Request('http://127.0.0.1:4060/mcp', {
        method: 'POST',
        headers: { 'mcp-protocol-version': version },
      })
      expect(validateMcpRequest(request, config).ok).toBe(true)
    }
  })

  test('supported protocol versions (snapshot — an SDK bump shows up in review)', () => {
    expect([...SUPPORTED_PROTOCOL_VERSIONS].sort()).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// §7.1 binds wikikit_read's OUTPUT to the §5.3 zConceptResponse shape — the
// same wire contract REST serves. Strict-parse the real tool output so the
// MCP transport can never leak internal ConceptDetail fields (revision_id,
// per-claim valid_from/valid_until/created_at/agent_meta) that the published
// contract excludes.
describe('wikikit_read output contract (§7.1 → §5.3)', () => {
  const SPACE_ID = '11111111-1111-4111-8111-111111111111'
  const CONCEPT_ID = '22222222-2222-4222-8222-222222222222'
  const REV_ID = '33333333-3333-4333-8333-333333333333'
  const CLAIM_ID = '44444444-4444-4444-8444-444444444444'
  const SOURCE_ID = '55555555-5555-4555-8555-555555555555'
  const NOW = new Date('2026-07-15T12:00:00Z')

  const principal: Principal = { keyId: 'key-1', scopes: ['knowledge:read'], spaceId: null, name: 'reader' }

  const stubDb = {
    async select(table: string) {
      if (table === 'wk_spaces') return [{ id: SPACE_ID, slug: 'demo' }]
      if (table === 'wk_claims') {
        return [
          {
            id: CLAIM_ID,
            subject: 'wikikit',
            predicate: 'is',
            object: 'headless',
            status: 'verified',
            confidence: 0.9,
            // Internal audit fields a naive passthrough would leak:
            valid_from: NOW,
            valid_until: null,
            created_at: NOW,
            agent_meta: { model: 'claude-sonnet-5', prompt_version: 'synthesize.v1' },
          },
        ]
      }
      if (table === 'wk_citations') {
        return [{ claim_id: CLAIM_ID, source_id: SOURCE_ID, quote: 'WikiKit is headless.', locator: '' }]
      }
      return []
    },
    async query(text: string) {
      if (text.includes('c.slug = $2')) {
        return {
          rows: [
            {
              concept_id: CONCEPT_ID,
              revision_id: REV_ID,
              slug: 'wikikit',
              title: 'WikiKit',
              summary: 'Headless knowledge system.',
              markdown: '# WikiKit\n',
              rev: 3,
              updated_at: NOW,
              agent_meta: { model: 'claude-sonnet-5' },
            },
          ],
          rowCount: 1,
        }
      }
      if (text.includes("rel.status = 'active'")) {
        return { rows: [{ to_slug: 'open-knowledge-format', kind: 'related' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as Db

  const deps: ToolDeps = { config: {} as Config, db: stubDb, ingest: {} as IngestPipeline }

  test('strict-parses as zConceptResponse — no extra fields on the MCP wire', async () => {
    const read = TOOLS.find((tool) => tool.name === 'wikikit_read')!
    const output = await read.execute(deps, principal, { space: 'demo', slug: 'wikikit' })
    // Round-trip through JSON like the transport does, then STRICT parse:
    // any field beyond the contract fails the suite.
    const wire = JSON.parse(JSON.stringify(output)) as Record<string, unknown>
    const parsed = zConceptResponse.strict().safeParse(wire)
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true)
    // Belt-and-braces on the nested claim: exactly the contracted key set.
    const claim = (wire.claims as Record<string, unknown>[])[0]!
    expect(Object.keys(claim).sort()).toEqual([
      'citations',
      'confidence',
      'id',
      'object',
      'predicate',
      'status',
      'subject',
    ])
    expect(wire).not.toHaveProperty('revision_id')
  })
})
