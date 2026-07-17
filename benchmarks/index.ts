// Deterministic, network-free benchmarks — `bun run bench`.
//
// Scope, deliberately: this measures the CPU work WikiKit does around the model
// (prompt assembly, the grounding guard, the markdown pipeline, chunking).
// It never calls a provider — a benchmark that costs money and needs a key is a
// benchmark nobody runs.
//
// WHY this is not in the push gate: wall-clock numbers depend on the machine and
// on what else it is doing, so asserting on them would produce flaky failures
// that train people to bypass the gate. This reports; it does not judge. The one
// property here that IS a hard regression — prompt SIZE, which costs real money
// on every single call — is asserted deterministically in
// test/unit/prompt-budget.test.ts, which the gate does run.
import { estimateTokens, fitTokenBudget, splitMarkdown } from '../src/ingest/chunk.ts'
import { extractWikiLinks, normalizeMarkdown, parseFrontmatter, serializeFrontmatter } from '../src/markdown.ts'
import * as answerV1 from '../src/llm/prompts/answer.v1.ts'
import * as classifyV1 from '../src/llm/prompts/classify.v1.ts'
import * as distillV1 from '../src/llm/prompts/distill.v1.ts'
import * as synthesizeV1 from '../src/llm/prompts/synthesize.v1.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Result {
  name: string
  opsPerSecond: number
  meanMs: number
  note?: string
}

const results: Result[] = []

/** Time `fn` over enough iterations to be meaningful, after a warmup. */
function bench(name: string, fn: () => void, { iterations = 200, note }: { iterations?: number; note?: string } = {}) {
  for (let i = 0; i < Math.min(20, iterations); i++) fn() // warm the JIT
  const started = Bun.nanoseconds()
  for (let i = 0; i < iterations; i++) fn()
  const elapsedMs = (Bun.nanoseconds() - started) / 1e6
  results.push({ name, opsPerSecond: (iterations / elapsedMs) * 1000, meanMs: elapsedMs / iterations, note })
}

// ---------------------------------------------------------------------------
// Fixtures — sized like the real thing, generated so the file stays readable
// ---------------------------------------------------------------------------

const paragraph =
  'The Open Knowledge Format is a draft specification at v0.1. It bundles concepts, claims and citations as portable Markdown with frontmatter. '

/** ~50k chars ≈ a long article/report — the size where these paths start to matter. */
const largeSource = Array.from({ length: 120 }, (_, i) => `## Section ${i}\n\n${paragraph.repeat(3)}\n`).join('\n')

const conceptIndex = Array.from({ length: 50 }, (_, i) => ({
  slug: `concept-${i}`,
  title: `Concept ${i}`,
  summary: 'A maintained concept page with claims and citations.',
}))

const frontmatterDoc = serializeFrontmatter(
  { type: 'Concept', title: 'Open Knowledge Format', claims: [{ subject: 'okf', predicate: 'is', object: 'draft' }] },
  largeSource.slice(0, 8000),
)

// The grounding guard, reproduced: it is module-private in the pipeline, so the
// benchmark carries a copy. If the real one changes shape, this number stops
// describing it — that is the cost of measuring a private function, accepted
// here because the O(claims × source) behavior is the thing worth watching.
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
const quoteGroundedIn = (quote: string, source: string) => norm(source).includes(norm(quote))

const quotes = Array.from({ length: 20 }, (_, i) => `## Section ${i}`)

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

// The prompt renderers run once per LLM call; if one of them got quadratic in
// the concept index or source size, every ingest would slow down silently.
bench('classify.v1 render (50 concepts, 50k source)', () => {
  classifyV1.render({ source: { title: 'Report', markdown: largeSource }, conceptIndex })
})

bench('synthesize.v1 render (50k source)', () => {
  synthesizeV1.render({
    concept: { slug: 'okf', title: 'OKF', currentMarkdown: largeSource.slice(0, 5000) },
    source: { id: 'src-1', title: 'Report', markdown: largeSource },
    predicates: ['is', 'has_status'],
  })
})

bench('answer.v1 render (8 evidence items)', () => {
  answerV1.render({
    question: 'Is OKF production ready?',
    evidence: Array.from({ length: 8 }, (_, i) => ({
      kind: 'concept' as const,
      slug: `concept-${i}`,
      text: paragraph.repeat(4),
      status: null,
    })),
  })
})

bench('distill.v1 render (50k transcript)', () => {
  distillV1.render({ transcript: largeSource })
})

// The guard normalizes the WHOLE source once per claim (O(claims × source)).
// This is the number to watch: a 20-claim synthesis over a large source pays
// for the same normalization 20 times.
bench(
  'grounding guard: 20 claims × 50k source',
  () => {
    for (const quote of quotes) quoteGroundedIn(quote, largeSource)
  },
  { iterations: 100, note: 'O(claims × source) — re-normalizes the source per claim' },
)

// unified/remark is the most expensive non-LLM step in ingest.
bench('parseFrontmatter (8k doc)', () => void parseFrontmatter(frontmatterDoc), { iterations: 100 })
bench('normalizeMarkdown (50k source)', () => void normalizeMarkdown(largeSource), { iterations: 20 })
bench('extractWikiLinks (50k source)', () => void extractWikiLinks(largeSource), { iterations: 100 })

bench('splitMarkdown (50k source)', () => void splitMarkdown(largeSource), { iterations: 100 })
bench('fitTokenBudget (50k source → 4k tokens)', () => void fitTokenBudget(largeSource, 4000), { iterations: 100 })

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const fmt = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1))

console.log('\nWikiKit benchmarks — deterministic, no network\n')
const width = Math.max(...results.map((r) => r.name.length))
for (const result of results) {
  const line = `  ${result.name.padEnd(width)}  ${fmt(result.opsPerSecond).padStart(9)} ops/s  ${result.meanMs.toFixed(3).padStart(8)} ms`
  console.log(result.note ? `${line}\n  ${' '.repeat(width)}  ↳ ${result.note}` : line)
}

// Prompt sizes are the cost story: these tokens are billed on EVERY call, and
// the system prompts are billed at cache-read rates only AFTER the first call.
// Sizes are asserted in test/unit/prompt-budget.test.ts; printed here so a
// change is visible while you work on a prompt.
console.log('\nSystem prompt sizes (billed on every call — cached prefix after the first):\n')
for (const [name, system] of [
  ['classify.v1', classifyV1.system],
  ['synthesize.v1', synthesizeV1.system],
  ['answer.v1', answerV1.system],
  ['distill.v1', distillV1.system],
] as const) {
  console.log(
    `  ${name.padEnd(14)} ${String(system.length).padStart(6)} chars  ≈ ${String(estimateTokens(system)).padStart(5)} tokens`,
  )
}
console.log()
