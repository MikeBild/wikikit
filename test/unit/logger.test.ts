import { describe, expect, test } from 'bun:test'
import { createLogger } from '../../src/logger.ts'

function capture() {
  const lines: string[] = []
  return { lines, write: (line: string) => void lines.push(line) }
}

describe('createLogger', () => {
  test('emits one JSON line per event with ts/level/msg', () => {
    const { lines, write } = capture()
    const log = createLogger({ write })
    log.info('hello', { requestId: 'abc123' })

    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.level).toBe('info')
    expect(parsed.msg).toBe('hello')
    expect(parsed.requestId).toBe('abc123')
    expect(new Date(parsed.ts).toString()).not.toBe('Invalid Date')
    expect(lines[0]!.endsWith('\n')).toBe(true)
  })

  test('respects the level threshold', () => {
    const { lines, write } = capture()
    const log = createLogger({ level: 'warn', write })
    log.debug('nope')
    log.info('nope')
    log.warn('yes')
    log.error('yes')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]!).level).toBe('warn')
    expect(JSON.parse(lines[1]!).level).toBe('error')
  })

  test('unknown level falls back to info', () => {
    const { lines, write } = capture()
    const log = createLogger({ level: 'shouting', write })
    log.debug('filtered')
    log.info('kept')
    expect(lines.length).toBe(1)
  })

  test('child() merges base fields into every line and stays overridable', () => {
    const { lines, write } = capture()
    const log = createLogger({ write }).child({ requestId: 'req-1', space: 'docs' })
    log.info('scoped')
    log.info('override', { space: 'other' })

    expect(JSON.parse(lines[0]!)).toMatchObject({ requestId: 'req-1', space: 'docs' })
    expect(JSON.parse(lines[1]!)).toMatchObject({ requestId: 'req-1', space: 'other' })
  })
})
