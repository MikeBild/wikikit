import { describe, expect, test } from 'bun:test'
import { createTraceContext } from '../../src/trace-context.ts'

describe('W3C trace context', () => {
  test('continues a valid trace id with a new span id', () => {
    const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const trace = createTraceContext(incoming)
    expect(trace.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(trace.spanId).not.toBe('00f067aa0ba902b7')
    expect(trace.parentSpanId).toBe('00f067aa0ba902b7')
    expect(trace.traceparent).toBe(`00-${trace.traceId}-${trace.spanId}-01`)
  })

  test('rejects malformed and all-zero identifiers', () => {
    for (const value of ['', 'garbage', '00-00000000000000000000000000000000-0000000000000000-01']) {
      const trace = createTraceContext(value)
      expect(trace.traceId).toMatch(/^(?!0{32})[0-9a-f]{32}$/)
      expect(trace.parentSpanId).toBeNull()
    }
  })
})
