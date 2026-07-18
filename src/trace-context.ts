import { randomBytes } from 'node:crypto'

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

export interface TraceContext {
  traceId: string
  spanId: string
  parentSpanId: string | null
  traceFlags: string
  traceparent: string
}

export function createTraceContext(value?: string): TraceContext {
  const match = TRACEPARENT.exec(value?.trim().toLowerCase() ?? '')
  const continued = match && !/^0+$/.test(match[1]!) && !/^0+$/.test(match[2]!)
  const traceId = continued ? match[1]! : randomBytes(16).toString('hex')
  const spanId = randomBytes(8).toString('hex')
  const traceFlags = continued ? match[3]! : '01'
  return {
    traceId,
    spanId,
    parentSpanId: continued ? match[2]! : null,
    traceFlags,
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
  }
}
