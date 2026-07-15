// Token budgeting for ingest (plan §15.4: "Chunking + WIKIKIT_MAX_INGEST_TOKENS").
//
// WHY a heuristic instead of a real tokenizer: the budget exists to bound LLM
// cost and context size, not to bill by the token. chars/4 is the industry
// rule of thumb for English/markdown, it is dependency-free (nothing to bundle
// into the Bun binary), and it is deterministic across provider/model changes
// — a real tokenizer would make the SAME document "fit" under one model and
// "overflow" under the next, which would change proposal input hashes for no
// knowledge reason. The heuristic errs conservative on prose and generous on
// code; WIKIKIT_MAX_INGEST_TOKENS defaults to 100k against a 200k+ context
// window, so the slack absorbs the error.
//
// WHY heading-aligned truncation instead of a hard character slice: what
// survives the budget is what the synthesize model reads. Cutting mid-sentence
// invites hallucinated completions; cutting at section boundaries keeps every
// retained passage quotable verbatim — and verbatim quotes are the citation
// contract (a claim's quote must be copyable character-for-character from the
// stored source).

/** Approximate LLM token count: ceil(chars / 4). Deterministic, model-free. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface MarkdownChunk {
  /** The chunk's own heading line (e.g. '## Deployment'), null for preamble/paragraph splits. */
  heading: string | null
  /** Chunk text including its heading line. */
  text: string
  tokens: number
}

const HEADING_PATTERN = /^#{1,6}[ \t]+\S/

// Split oversized heading sections further at blank-line paragraph boundaries
// so the budget packer can keep the FRONT of a section instead of dropping it
// wholesale. A pathological single paragraph larger than the whole budget is
// finally hard-sliced — the only place a mid-text cut can happen, and only for
// documents with no structure to respect.
function splitParagraphs(text: string, heading: string | null): MarkdownChunk[] {
  return text
    .split(/\n{2,}/)
    .filter((part) => part.trim().length > 0)
    .map((part) => ({ heading, text: part, tokens: estimateTokens(part) }))
}

/**
 * Split markdown into heading-aligned chunks (preamble first, then one chunk
 * per ATX heading section). Fenced code blocks are respected: a `#` inside a
 * fence never starts a chunk, so code samples survive intact.
 */
export function splitMarkdown(markdown: string): MarkdownChunk[] {
  const lines = markdown.split('\n')
  const chunks: MarkdownChunk[] = []
  let current: string[] = []
  let currentHeading: string | null = null
  let inFence = false

  const flush = () => {
    const text = current.join('\n')
    if (text.trim().length > 0) {
      chunks.push({ heading: currentHeading, text, tokens: estimateTokens(text) })
    }
    current = []
  }

  for (const line of lines) {
    // Track ``` / ~~~ fences so headings inside code blocks are treated as code.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && HEADING_PATTERN.test(line)) {
      flush()
      currentHeading = line.trim()
    }
    current.push(line)
  }
  flush()
  return chunks
}

export interface BudgetResult {
  /** The (possibly truncated) markdown that fits the budget. */
  markdown: string
  /** Estimated tokens of the returned markdown. */
  tokens: number
  /** True when content had to be dropped to meet the budget. */
  truncated: boolean
}

// Reserved slack for the truncation notice appended to cut documents — the
// notice itself (~28 tokens with a 6-digit budget number) must never push the
// result back over the budget.
const NOTICE_RESERVE_TOKENS = 32

/**
 * Fit markdown into a token budget by keeping whole heading sections front-to-
 * back (document order preserves the author's priority: title, abstract and
 * early sections first). Sections that individually overflow are packed
 * paragraph-by-paragraph. When anything is dropped, a short notice tells the
 * model the document was truncated — an LLM that silently receives half a
 * document will confidently "summarize" the missing half.
 *
 * Idempotent: fit(fit(x, n).markdown, n) returns the same markdown, so calling
 * it defensively at multiple pipeline stages is safe.
 */
export function fitTokenBudget(markdown: string, maxTokens: number): BudgetResult {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('maxTokens must be a positive integer')
  const total = estimateTokens(markdown)
  if (total <= maxTokens) return { markdown, tokens: total, truncated: false }

  const budget = Math.max(1, maxTokens - NOTICE_RESERVE_TOKENS)
  const kept: string[] = []
  let used = 0

  const tryKeep = (chunk: MarkdownChunk): boolean => {
    // +1 accounts for the joining blank line between kept chunks.
    if (used + chunk.tokens + 1 > budget) return false
    kept.push(chunk.text)
    used += chunk.tokens + 1
    return true
  }

  outer: for (const section of splitMarkdown(markdown)) {
    if (tryKeep(section)) continue
    // Section too big as a whole — descend to paragraphs and keep the front.
    for (const paragraph of splitParagraphs(section.text, section.heading)) {
      if (tryKeep(paragraph)) continue
      if (used === 0) {
        // Nothing kept yet and even the first paragraph overflows: hard-slice
        // so a structureless megadocument still yields SOMETHING to classify.
        kept.push(paragraph.text.slice(0, budget * 4))
        used = budget
      }
      break outer
    }
    break
  }

  // A kept heading whose entire body was dropped is worse than no heading:
  // the model would read an empty section as "this section says nothing"
  // rather than "this section was cut".
  while (kept.length > 0 && /^#{1,6}[ \t]+\S[^\n]*$/.test(kept[kept.length - 1]!.trim())) kept.pop()

  const notice = `> [!NOTE] Source truncated to fit the ingest token budget (${maxTokens} tokens); later sections were omitted.`
  const result = `${kept.join('\n\n')}\n\n${notice}`
  return { markdown: result, tokens: estimateTokens(result), truncated: true }
}
