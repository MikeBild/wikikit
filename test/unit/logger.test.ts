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

  test('sdJournal prefixes every line with its <N> syslog priority', () => {
    const { lines, write } = capture()
    const log = createLogger({ level: 'debug', write, sdJournal: true })
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(lines.map((line) => line.slice(0, 3))).toEqual(['<7>', '<6>', '<4>', '<3>'])
    // The prefix wraps the line, never leaks into it — journald strips it and
    // stores the bare JSON every log consumer parses.
    for (const line of lines) expect(() => JSON.parse(line.slice(3))).not.toThrow()
  })

  test('sdJournal defaults to $JOURNAL_STREAM presence (systemd) and off elsewhere', () => {
    const saved = process.env.JOURNAL_STREAM
    try {
      process.env.JOURNAL_STREAM = '8:123456'
      const journal = capture()
      createLogger({ write: journal.write }).error('boom')
      expect(journal.lines[0]!.startsWith('<3>{')).toBe(true)

      delete process.env.JOURNAL_STREAM
      const terminal = capture()
      createLogger({ write: terminal.write }).error('boom')
      expect(terminal.lines[0]!.startsWith('{')).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.JOURNAL_STREAM
      else process.env.JOURNAL_STREAM = saved
    }
  })

  test('child() keeps the sdJournal prefix behavior', () => {
    const { lines, write } = capture()
    const log = createLogger({ write, sdJournal: true }).child({ requestId: 'req-1' })
    log.error('scoped failure')
    expect(lines[0]!.startsWith('<3>{')).toBe(true)
    expect(JSON.parse(lines[0]!.slice(3))).toMatchObject({ level: 'error', requestId: 'req-1' })
  })
})
