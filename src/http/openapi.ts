// OpenAPI 3.1 document generated from the ROUTES registry — served live at
// GET /openapi.json, snapshotted into docs/openapi.json, drift-tested against
// both.
//
// WHY generated and never hand-written: connector importers (and any OpenAPI
// tooling) build connectors from this document. A spec that
// drifts from the router produces connectors that fail at runtime; deriving
// both from ROUTES makes that class of bug unrepresentable.
//
// Schemas come from zod v4's native z.toJSONSchema — the SAME objects that
// validate requests at runtime, referenced under #/components/schemas by
// their export names. Request schemas render with io:'input' (defaults
// optional — what a CLIENT must send) and response schemas with io:'output'
// (defaults applied — what a client will receive).
import { z } from 'zod'
import { SCHEMAS } from './schemas.ts'
import type { RouteDef } from './routes.ts'

export interface OpenApiDocument {
  openapi: '3.1.0'
  info: { title: string; version: string; description: string }
  servers: { url: string }[]
  paths: Record<string, Record<string, unknown>>
  components: {
    securitySchemes: Record<string, unknown>
    schemas: Record<string, unknown>
  }
}

function schemaByName(name: string): z.ZodType {
  const schema = SCHEMAS[name]
  if (!schema) throw new Error(`route references unknown schema '${name}' — add it to SCHEMAS in schemas.ts`)
  return schema
}

// One JSON Schema per (name, io-direction). `$ref` locality: zod would emit
// nested $refs for reused sub-schemas; unrepresentable() never triggers on
// our plain shapes, and 'draft-2020-12' is what OpenAPI 3.1 natively speaks.
function toJsonSchema(name: string, io: 'input' | 'output'): Record<string, unknown> {
  const json = z.toJSONSchema(schemaByName(name), { target: 'draft-2020-12', io }) as Record<string, unknown>
  delete json.$schema // implied by OpenAPI 3.1, noisy inside components
  return json
}

/** Error statuses every authenticated route can produce — appended once here instead of 25 times in the table. */
const IMPLICIT_ERRORS: Record<number, string> = {
  400: 'bad_request — request failed schema validation',
  401: 'unauthorized — missing, unknown or revoked API key',
  403: 'insufficient_scope — key lacks the required scope or is scoped to another space',
  404: 'not_found',
  500: 'internal_error',
}

export function buildOpenApi(routes: RouteDef[], opts: { version: string }): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {}
  const components: Record<string, unknown> = {}

  // Register a named schema in components (first io wins — no name is used in
  // both directions) and return its $ref.
  const registered = new Map<string, string>()
  function ref(name: string, io: 'input' | 'output'): { $ref: string } {
    if (!registered.has(name)) {
      components[name] = toJsonSchema(name, io)
      registered.set(name, io)
    }
    return { $ref: `#/components/schemas/${name}` }
  }

  for (const route of routes) {
    const op: Record<string, unknown> = {
      summary: route.summary,
      operationId: route.handler.replace(/Handler$/, ''),
      responses: {} as Record<string, unknown>,
    }

    // Path parameters from the template; pattern/description enrichment comes
    // from the declared params schema when present.
    const parameters: Record<string, unknown>[] = []
    const paramProps = route.request?.params
      ? ((toJsonSchema(route.request.params, 'input').properties ?? {}) as Record<string, unknown>)
      : {}
    for (const match of route.path.matchAll(/\{(\w+)\}/g)) {
      parameters.push({
        name: match[1],
        in: 'path',
        required: true,
        schema: paramProps[match[1]!] ?? { type: 'string' },
      })
    }

    if (route.request?.query) {
      const json = toJsonSchema(route.request.query, 'input')
      const props = (json.properties ?? {}) as Record<string, unknown>
      const required = new Set((json.required as string[] | undefined) ?? [])
      for (const [name, schema] of Object.entries(props)) {
        parameters.push({ name, in: 'query', required: required.has(name), schema })
      }
    }
    if (parameters.length) op.parameters = parameters

    if (route.rawBody) {
      op.requestBody = {
        required: true,
        content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
      }
    } else if (route.request?.body) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: ref(route.request.body, 'input') } },
      }
    }

    const responses = op.responses as Record<string, unknown>
    for (const [status, spec] of Object.entries(route.responses)) {
      responses[status] = {
        description: spec.desc,
        content: spec.schema
          ? { [spec.type]: { schema: ref(spec.schema, 'output') } }
          : spec.type
            ? { [spec.type]: {} }
            : undefined,
      }
    }
    if (route.scope) {
      op.security = [{ bearerAuth: [] }, { apiKey: [] }]
      // Vendor extension consumed by agents reading the raw spec: which scope
      // a key needs for this operation.
      op['x-required-scope'] = route.scope
      for (const [status, desc] of Object.entries(IMPLICIT_ERRORS)) {
        if (!(status in responses)) {
          responses[status] = {
            description: desc,
            content: { 'application/json': { schema: ref('zErrorEnvelope', 'output') } },
          }
        }
      }
    }

    paths[route.path] ??= {}
    paths[route.path]![route.method] = op
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'WikiKit API',
      version: opts.version,
      description:
        'Headless, AI-native knowledge system for humans and agents. ' +
        'Markdown-first knowledge in; structured, cited, review-gated knowledge out. ' +
        'Scopes: knowledge:read | knowledge:propose | knowledge:approve | admin. ' +
        'MCP (Streamable HTTP) is available at POST /mcp, outside this REST surface; ' +
        'remote MCP clients use OAuth 2.1 discovery, PKCE and explicitly requested scopes.',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer wk_...' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: components,
    },
  }
}
