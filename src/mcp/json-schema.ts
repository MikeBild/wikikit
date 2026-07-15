// Zod → JSON Schema (draft-7) at the MCP tool-palette boundary.
//
// Every tool input schema that reaches an MCP client funnels through this one
// helper so the emitted shape stays identical across the whole manifest (the
// contract test in test/contract/mcp-manifest.test.ts snapshots it). Ported
// from SubKit's production json-schema.ts with one deliberate difference,
// documented below.
//
// WHY the SDK's `toJsonSchemaCompat` instead of zod's native exporter: the
// SDK helper is the officially supported bridge for the zod version range the
// SDK itself accepts, so the manifest can never drift from what the SDK's own
// validators expect (SubKit learning — one unavoidable type bridge, kept in
// exactly one spot).
//
// WHY `pipeStrategy: 'input'` where SubKit ships 'output': these schemas
// describe TOOL INPUTS. Under 'output' semantics zod treats every `.default()`
// field as always-present and lists it in `required` — an MCP client reading
// that manifest would believe it must send `summary`, `source_ids`, ... on
// every wikikit_propose call. Input semantics keep defaulted fields optional,
// which is the honest contract for callers. The price is that the exporter no
// longer emits `additionalProperties:false` on plain objects — restored by the
// normalization pass below, because a closed manifest is the WikiKit contract
// (§7: draft-07 with additionalProperties:false): agents must get a hard
// signal when they invent parameters instead of having them silently stripped
// by zod at parse time.
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import type { ZodType } from 'zod'

function normalize(node: unknown): void {
  if (Array.isArray(node)) {
    for (const entry of node) normalize(entry)
    return
  }
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>

  // Top-level dialect marker — noise for MCP clients (the spec fixes the
  // dialect per protocol version) and absent from SubKit's frozen shape.
  delete obj.$schema

  if (obj.type === 'object') {
    if ('propertyNames' in obj && 'additionalProperties' in obj) {
      // Record types: zod annotates the key schema as `propertyNames`
      // alongside the value schema in `additionalProperties`. Collapse to the
      // bare additionalProperties form (keys are strings anyway) — the shape
      // SubKit verified byte-identical across its live registry.
      delete obj.propertyNames
    } else if ('properties' in obj && obj.additionalProperties === undefined) {
      // Closed-world objects everywhere (see header). Records above keep
      // their value schema in additionalProperties untouched.
      obj.additionalProperties = false
    }
  }

  for (const value of Object.values(obj)) normalize(value)
}

/**
 * Convert a zod schema to the draft-7 JSON Schema an MCP client consumes:
 * no `$schema` marker, `additionalProperties:false` on every plain object,
 * defaulted fields optional. The single `as never` bridges our `zod` types to
 * the SDK's structurally-compatible zod-compat nominal type — confined here so
 * no call site ever needs a cast.
 */
export function zodToJsonSchema7(schema: ZodType): Record<string, unknown> {
  const out = toJsonSchemaCompat(schema as never, {
    target: 'jsonSchema7',
    pipeStrategy: 'input',
  })
  normalize(out)
  return out
}
