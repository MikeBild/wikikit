// Compile-time embedded LLM docs — so the single self-contained binary serves
// the REAL llms.txt / llms-full.txt with no docs/ directory on disk beside it.
//
// Bun inlines these text imports into `bun build --compile` (the same
// self-contained principle as the embedded migrations). Because the embedded
// value IS the file at build time, it cannot drift from docs/. Dev still
// prefers the on-disk copy for live edits (readDocsFile tries the filesystem
// first); this embed is the fallback the compiled binary always resolves.
import llmsTxt from '../../docs/llms.txt' with { type: 'text' }
import llmsFullTxt from '../../docs/llms-full.txt' with { type: 'text' }

export const EMBEDDED_DOCS: Record<string, string> = {
  'llms.txt': llmsTxt,
  'llms-full.txt': llmsFullTxt,
}
