// Compile-time embedded LLM docs — so the single self-contained binary serves
// the REAL llms.txt / llms-full.txt with no docs/ directory on disk beside it.
//
// Bun inlines these text imports into `bun build --compile` (the same
// self-contained principle as the embedded migrations). Because the embedded
// value IS the file at build time, it cannot drift from docs/. Dev still
// prefers the on-disk copy for live edits (readDocsFile tries the filesystem
// first); this embed is the fallback the compiled binary always resolves.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import llmsTxt from '../../docs/llms.txt' with { type: 'text' }
import llmsFullTxt from '../../docs/llms-full.txt' with { type: 'text' }

export const EMBEDDED_DOCS: Record<string, string> = {
  'llms.txt': llmsTxt,
  'llms-full.txt': llmsFullTxt,
}

// Cached after first read — release artifacts, not hot-reload content.
const docsCache = new Map<string, string | null>()

/**
 * Resolve a docs file: on-disk first (dev live edits), embedded copy otherwise
 * (the path the compiled binary always hits). Shared by the REST docs routes
 * and the MCP resources surface so both serve byte-identical content.
 */
export function readDocsFile(config: Config, name: string): string | null {
  if (!docsCache.has(name)) {
    let content: string | null = null
    for (const root of [config.root, process.cwd()]) {
      try {
        // join() inside the try on purpose: the embedded copy is the whole
        // point of this function, so a bad root must fall through to it, not
        // throw past it.
        content = readFileSync(join(root, 'docs', name), 'utf8')
        break
      } catch {
        // try next location
      }
    }
    content ??= EMBEDDED_DOCS[name] ?? null
    docsCache.set(name, content)
  }
  return docsCache.get(name) ?? null
}
