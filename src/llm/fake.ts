// FakeProvider — deterministic, network-free LlmProvider (CONTRACTS.md §3.3).
//
// WHY it lives in src/ and not test/: the ingest pipeline and query modules
// are exercised by integration tests (and the composition root in LLM-free
// dev) through the SAME import surface as production code; test files re-
// export it from test/helpers/fake-provider.ts. Defaults are intentionally
// boring and fully derivable from the input so pipeline tests can predict
// every row the pipeline will write. `calls` records inputs in order — the
// assertion surface ("classify was called once, with THIS source").
//
// WHY run meta uses real prompt_version constants + the shared input hash:
// the pipeline persists run meta verbatim into wk_agent_runs/agent_meta;
// tests asserting on those rows must see production-shaped values, and hash
// parity with the real provider means dedup logic behaves identically.
import { createHash } from 'node:crypto'
import {
  computeInputHash,
  type EmbedInput,
  type EmbedOutput,
  type LlmProvider,
  type LlmResult,
  type LlmRunMeta,
} from './provider.ts'
import { PROMPT_VERSIONS } from './prompts/index.ts'
import * as classifyV1 from './prompts/classify.v1.ts'
import * as synthesizeV1 from './prompts/synthesize.v1.ts'
import * as answerV1 from './prompts/answer.v1.ts'
import * as distillV1 from './prompts/distill.v1.ts'
import * as adjudicateV1 from './prompts/adjudicate.v1.ts'
import type {
  AdjudicateInput,
  AdjudicateOutput,
  AnswerInput,
  AnswerOutput,
  ClassifyInput,
  ClassifyOutput,
  DistillInput,
  DistillOutput,
  SynthesizeInput,
  SynthesizeOutput,
} from './schemas.ts'

export interface FakeCall {
  method: 'classify' | 'synthesize' | 'answer' | 'distill' | 'embed' | 'adjudicate'
  input: unknown
}

export interface FakeProvider extends LlmProvider {
  /** Recorded in call order — assertion surface for tests. */
  readonly calls: FakeCall[]
}

/** Derive a DB-valid concept slug from a source title (matches wk_concepts CHECK). */
function slugify(title: string | null): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 127)
    .replace(/-+$/, '')
  return slug || 'untitled-source'
}

function firstLine(markdown: string): string {
  return (
    markdown
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? markdown
  )
}

export function createFakeProvider(overrides?: {
  classify?: (input: ClassifyInput) => ClassifyOutput
  synthesize?: (input: SynthesizeInput) => SynthesizeOutput
  answer?: (input: AnswerInput) => AnswerOutput
  distill?: (input: DistillInput) => DistillOutput
  adjudicate?: (input: AdjudicateInput) => AdjudicateOutput
}): FakeProvider {
  const calls: FakeCall[] = []

  function run(promptVersion: string, system: string, rendered: string): LlmRunMeta {
    return {
      model: 'fake',
      prompt_version: promptVersion,
      input_hash: computeInputHash(promptVersion, system, rendered),
      usage: { input_tokens: 0, output_tokens: 0 },
      duration_ms: 0,
    }
  }

  return {
    configured: true,
    // Never surfaces (configured is always true) — present to satisfy the
    // interface and to keep a 503 assertion readable if a test forces one.
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    embedConfigured: true,
    calls,

    async embed(input: EmbedInput): Promise<LlmResult<EmbedOutput>> {
      calls.push({ method: 'embed', input })
      // Deterministic unit vectors seeded from sha256(text): stable across
      // runs, and full 1536 dims so they insert into the real
      // wk_embeddings vector(1536) column in integration tests.
      const embeddings = input.texts.map((text) => {
        const digest = createHash('sha256').update(text, 'utf8').digest()
        const raw = Array.from({ length: 1536 }, (_, i) => (digest[(i * 7 + (i % 5)) % 32]! - 128) / 128)
        const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0)) || 1
        return raw.map((value) => value / norm)
      })
      return {
        output: { embeddings, dimensions: 1536 },
        run: {
          model: 'fake',
          prompt_version: 'embed.v1',
          input_hash: computeInputHash('embed.v1', '', input.texts.join('\n ')),
          usage: { input_tokens: 0, output_tokens: 0 },
          duration_ms: 0,
        },
      }
    },

    async classify(input: ClassifyInput): Promise<LlmResult<ClassifyOutput>> {
      calls.push({ method: 'classify', input })
      const output =
        overrides?.classify?.(input) ??
        // Default: affects nothing, proposes one new concept from the title.
        ({
          affected: [],
          new: [{ slug: slugify(input.source.title), title: input.source.title ?? 'Untitled Source' }],
        } satisfies ClassifyOutput)
      return { output, run: run(PROMPT_VERSIONS.classify, classifyV1.system, classifyV1.render(input)) }
    },

    async synthesize(input: SynthesizeInput): Promise<LlmResult<SynthesizeOutput>> {
      calls.push({ method: 'synthesize', input })
      const output =
        overrides?.synthesize?.(input) ??
        // Default: echo the source markdown, one grounded claim. A meeting
        // source additionally yields one decision, so the decision-mining path
        // is exercised deterministically offline (pipeline/apply tests).
        ({
          title: input.concept.title,
          summary: firstLine(input.source.markdown),
          markdown: input.source.markdown,
          claims: [
            {
              subject: input.concept.slug,
              predicate: 'is',
              object: 'described',
              quote: firstLine(input.source.markdown),
              confidence: 0.9,
              valid_from: null,
              valid_until: null,
              context: null,
            },
          ],
          relations: [],
          decisions:
            input.sourceKind === 'meeting'
              ? [
                  {
                    slug: `${input.concept.slug}-decision`,
                    title: `Decision on ${input.concept.title}`,
                    context: firstLine(input.source.markdown),
                    decision: firstLine(input.source.markdown),
                    rationale: '',
                    alternatives: [],
                  },
                ]
              : [],
        } satisfies SynthesizeOutput)
      return { output, run: run(PROMPT_VERSIONS.synthesize, synthesizeV1.system, synthesizeV1.render(input)) }
    },

    async answer(input: AnswerInput): Promise<LlmResult<AnswerOutput>> {
      calls.push({ method: 'answer', input })
      const output =
        overrides?.answer?.(input) ??
        (input.evidence.length === 0
          ? ({
              answer_markdown: 'This is not covered by the knowledge base.',
              cited_slugs: [],
              not_in_knowledge_base: true,
              cited_source_ids: [],
            } satisfies AnswerOutput)
          : ({
              answer_markdown: input.evidence.map((e) => (e.slug ? `${e.text} [${e.slug}]` : e.text)).join('\n\n'),
              cited_slugs: [...new Set(input.evidence.flatMap((e) => (e.slug ? [e.slug] : [])))],
              not_in_knowledge_base: false,
              // Mirrors the deterministic slug behavior: every source-chunk
              // evidence item counts as cited.
              cited_source_ids: [...new Set(input.evidence.flatMap((e) => (e.source_id ? [e.source_id] : [])))],
            } satisfies AnswerOutput))
      return { output, run: run(PROMPT_VERSIONS.answer, answerV1.system, answerV1.render(input)) }
    },

    async adjudicate(input: AdjudicateInput): Promise<LlmResult<AdjudicateOutput>> {
      calls.push({ method: 'adjudicate', input })
      // Default matches the prompt's own bias: when in doubt, contradictory —
      // a human resolves disputes, a missed contradiction corrupts the base.
      const output =
        overrides?.adjudicate?.(input) ??
        ({ verdict: 'contradictory', reason: 'fake default verdict' } satisfies AdjudicateOutput)
      return { output, run: run(PROMPT_VERSIONS.adjudicate, adjudicateV1.system, adjudicateV1.render(input)) }
    },

    async distill(input: DistillInput): Promise<LlmResult<DistillOutput>> {
      calls.push({ method: 'distill', input })
      const output =
        overrides?.distill?.(input) ??
        // Default: nothing — the honest default, since that is what a routine
        // session yields. Tests that want a learning pass an override, which
        // also keeps the "empty means no proposal" path the one you get for
        // free.
        ({ learnings: [] } satisfies DistillOutput)
      return { output, run: run(PROMPT_VERSIONS.distill, distillV1.system, distillV1.render(input)) }
    },
  }
}
