// buildOpenApi(ROUTES) — the document SubKit's import_connector_from_spec and
// the docs/openapi.json snapshot rely on.
import { describe, expect, test } from 'bun:test'
import { buildOpenApi } from '../../src/http/openapi.ts'
import { ROUTES } from '../../src/http/routes.ts'

const doc = buildOpenApi(ROUTES, { version: '9.9.9-test' })

describe('buildOpenApi', () => {
  test('is OpenAPI 3.1 with the injected version', () => {
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.version).toBe('9.9.9-test')
    expect(doc.info.title).toBe('WikiKit API')
  })

  test('covers every registry route and nothing else', () => {
    const fromDoc = Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`))
    const fromRoutes = ROUTES.map((r) => `${r.method} ${r.path}`)
    expect(fromDoc.sort()).toEqual(fromRoutes.sort())
  })

  test('/mcp is deliberately absent from the REST surface', () => {
    expect(Object.keys(doc.paths).some((p) => p.startsWith('/mcp'))).toBe(false)
  })

  test('scoped routes carry security + x-required-scope; public routes carry neither', () => {
    for (const route of ROUTES) {
      const op = doc.paths[route.path]![route.method] as Record<string, unknown>
      if (route.scope) {
        expect(op.security, route.path).toEqual([{ bearerAuth: [] }, { apiKey: [] }])
        expect(op['x-required-scope'], route.path).toBe(route.scope)
      } else {
        expect(op.security, route.path).toBeUndefined()
        expect(op['x-required-scope'], route.path).toBeUndefined()
      }
    }
  })

  test('path template placeholders are declared as required path parameters', () => {
    for (const route of ROUTES) {
      const op = doc.paths[route.path]![route.method] as {
        parameters?: { name: string; in: string; required: boolean }[]
      }
      for (const match of route.path.matchAll(/\{(\w+)\}/g)) {
        const param = (op.parameters ?? []).find((p) => p.in === 'path' && p.name === match[1])
        expect(param, `${route.path} param ${match[1]}`).toBeDefined()
        expect(param!.required).toBe(true)
      }
    }
  })

  test('query schemas become query parameters (coerced limit on concept list)', () => {
    const op = doc.paths['/v1/spaces/{space}/concepts']!.get as { parameters: { name: string; in: string }[] }
    const names = op.parameters.filter((p) => p.in === 'query').map((p) => p.name)
    expect(names.sort()).toEqual(['after', 'before', 'limit'])
  })

  test('request bodies reference components; referenced component schemas exist', () => {
    const ingest = doc.paths['/v1/spaces/{space}/ingest']!.post as {
      requestBody: { content: Record<string, { schema: { $ref?: string } }> }
    }
    const ref = ingest.requestBody.content['application/json']!.schema.$ref
    expect(ref).toBe('#/components/schemas/zIngestRequest')
    expect(doc.components.schemas.zIngestRequest).toBeDefined()

    // Every $ref in the document resolves.
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/(\w+)/g) ?? []
    for (const r of refs) {
      const name = r.split('/').pop()!
      expect(doc.components.schemas[name], r).toBeDefined()
    }
  })

  test('import takes a binary zip body, export declares application/zip', () => {
    const imp = doc.paths['/v1/spaces/{space}/import']!.post as { requestBody: { content: Record<string, unknown> } }
    expect(Object.keys(imp.requestBody.content)).toEqual(['application/zip'])
    const exp = doc.paths['/v1/spaces/{space}/export']!.get as {
      responses: Record<string, { content?: Record<string, unknown> }>
    }
    expect(Object.keys(exp.responses['200']!.content ?? {})).toEqual(['application/zip'])
  })

  test('authenticated routes gain the implicit 400/401/403/404/500 envelope responses', () => {
    const op = doc.paths['/v1/spaces/{space}/lint']!.get as { responses: Record<string, unknown> }
    for (const status of ['400', '401', '403', '404', '500']) {
      expect(op.responses[status], status).toBeDefined()
    }
    // Public probes stay minimal.
    const ready = doc.paths['/ready']!.get as { responses: Record<string, unknown> }
    expect(ready.responses['401']).toBeUndefined()
  })

  test('no stray $schema keys inside components (implied by OpenAPI 3.1)', () => {
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      expect((schema as Record<string, unknown>).$schema, name).toBeUndefined()
    }
  })

  test('security schemes declare Bearer and X-API-Key', () => {
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['apiKey', 'bearerAuth'])
  })
})
