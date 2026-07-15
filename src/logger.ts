// Structured JSON logger — one line per event on stdout.
//
// WHY structured-only: WikiKit is headless and runs under systemd/journald in
// production; JSON lines are the contract every log consumer (journalctl,
// deploy health gates, grep in incident response) relies on. There is no
// pretty/dev mode — dev reads the same JSON, so nothing diverges.
//
// WHY an injectable sink: tests capture log output without monkey-patching
// process.stdout, and the compiled binary keeps the default write path.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  [key: string]: unknown
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** New logger sharing sink+threshold with `fields` merged into every line (e.g. request_id). */
  child(fields: LogFields): Logger
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerOptions {
  /** Minimum level to emit. Unknown values fall back to 'info'. */
  level?: string
  /** Output sink; defaults to process.stdout. Injected in tests. */
  write?: (line: string) => void
  /** Base fields merged into every line (used by child()). */
  base?: LogFields
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVELS[options.level as LogLevel] ?? LEVELS.info
  const write = options.write ?? ((line: string) => process.stdout.write(line))
  const base = options.base ?? {}

  function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (LEVELS[level] < threshold) return
    // ts first, then level/msg, then fields: stable key order keeps `grep | jq`
    // pipelines and human eyeballs happy. Errors in fields are stringified by
    // JSON.stringify to `{}` — callers pass `error: String(err)` per convention.
    write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields })}\n`)
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger({ level: options.level, write: options.write, base: { ...base, ...fields } }),
  }
}
