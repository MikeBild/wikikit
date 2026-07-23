// FakeProvider contract tests (CONTRACTS.md §3.3): deterministic defaults,
// override hooks, call recording, and production-shaped run meta. The ingest
// pipeline's offline tests stand on these guarantees — if a default drifts,
// pipeline assertions drift with it, so the exact shapes are pinned here.
import { describe, expect, test } from 'bun:test'
import { createFakeProvider, loadLlmFixture } from '../helpers/fake-provider.ts'
import { computeInputHash } from '../../src/llm/provider.ts'
import { PROMPT_VERSIONS } from '../../src/llm/prompts/index.ts'
import * as classifyV1 from '../../src/llm/prompts/classify.v1.ts'
import {
  zAnswerOutput,
  zClassifyOutput,
  zSynthesizeOutput,
  type AnswerInput,
  type ClassifyInput,
  type ClassifyOutput,
  type SynthesizeInput,
} from '../../src/llm/schemas.ts'

const classifyInput: ClassifyInput = {
  source: { title: 'OKF Announcement!', markdown: '# OKF\n\nBody text.' },
  conceptIndex: [],
}

const synthesizeInput: SynthesizeInput = {
  concept: { slug: 'okf', title: 'OKF', currentMarkdown: null },
  source: { id: 'src-1', title: 'OKF Announcement', markdown: '\nOKF is a draft.\nMore detail.' },
  predicates: ['is'],
}

const answerInput: AnswerInput = {
  question: 'Is OKF ready?',
  evidence: [
    { kind: 'concept', slug: 'okf', text: 'OKF is a draft.', status: null },
    { kind: 'claim', slug: null, text: 'unattributed evidence', status: 'verified' },
    { kind: 'claim', slug: 'okf', text: 'okf has_status draft', status: 'verified' },
  ],
}

describe('defaults', () => {
  test('configured is always true', () => {
    expect(createFakeProvider().configured).toBe(true)
  })

  test('classify affects nothing and derives one new concept from the title', async () => {
    const { output } = await createFakeProvider().classify(classifyInput)
    expect(output).toEqual({ affected: [], new: [{ slug: 'okf-announcement', title: 'OKF Announcement!' }] })
    expect(zClassifyOutput.safeParse(output).success).toBe(true)
  })

  test('classify falls back to untitled-source for a null title', async () => {
    const { output } = await createFakeProvider().classify({ ...classifyInput, source: { title: null, markdown: 'x' } })
    expect(output.new).toEqual([{ slug: 'untitled-source', title: 'Untitled Source' }])
  })

  test('synthesize echoes the source markdown with one grounded claim', async () => {
    const { output } = await createFakeProvider().synthesize(synthesizeInput)
    expect(output.title).toBe('OKF')
    expect(output.markdown).toBe(synthesizeInput.source.markdown)
    expect(output.relations).toEqual([])
    expect(output.claims).toEqual([
      {
        subject: 'okf',
        predicate: 'is',
        object: 'described',
        quote: 'OKF is a draft.',
        confidence: 0.9,
        valid_from: null,
        valid_until: null,
        context: null,
      },
    ])
    expect(zSynthesizeOutput.safeParse(output).success).toBe(true)
  })

  test('answer reports not_in_knowledge_base on empty evidence', async () => {
    const { output } = await createFakeProvider().answer({ question: 'q', evidence: [] })
    expect(output.not_in_knowledge_base).toBe(true)
    expect(output.cited_slugs).toEqual([])
  })

  test('answer concatenates evidence and cites unique slugs', async () => {
    const { output } = await createFakeProvider().answer(answerInput)
    expect(output.not_in_knowledge_base).toBe(false)
    expect(output.cited_slugs).toEqual(['okf'])
    expect(output.answer_markdown).toContain('OKF is a draft. [okf]')
    expect(output.answer_markdown).toContain('unattributed evidence')
    expect(zAnswerOutput.safeParse(output).success).toBe(true)
  })
})

describe('call recording', () => {
  test('records every call in order with its input', async () => {
    const fake = createFakeProvider()
    await fake.classify(classifyInput)
    await fake.synthesize(synthesizeInput)
    await fake.answer(answerInput)
    expect(fake.calls.map((c) => c.method)).toEqual(['classify', 'synthesize', 'answer'])
    expect(fake.calls[0]!.input).toBe(classifyInput)
    expect(fake.calls[1]!.input).toBe(synthesizeInput)
  })
})

describe('overrides', () => {
  test('override output is returned verbatim and still recorded', async () => {
    const canned = loadLlmFixture<ClassifyOutput>('classify.output.json')
    const fake = createFakeProvider({ classify: () => canned })
    const { output } = await fake.classify(classifyInput)
    expect(output).toEqual(canned)
    expect(fake.calls).toHaveLength(1)
  })
})

describe('run meta (audit contract)', () => {
  test('uses model fake, real prompt_version constants, zero usage', async () => {
    const fake = createFakeProvider()
    const { run } = await fake.classify(classifyInput)
    expect(run.model).toBe('fake')
    expect(run.prompt_version).toBe(PROMPT_VERSIONS.classify)
    expect(run.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
    expect(run.duration_ms).toBe(0)
  })

  test('input_hash is the shared canonical hash over the rendered prompt', async () => {
    const { run } = await createFakeProvider().classify(classifyInput)
    expect(run.input_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(run.input_hash).toBe(
      computeInputHash(PROMPT_VERSIONS.classify, classifyV1.system, classifyV1.render(classifyInput)),
    )
  })

  test('input_hash is stable per input and distinct across inputs', async () => {
    const fake = createFakeProvider()
    const a = await fake.classify(classifyInput)
    const b = await fake.classify(classifyInput)
    const c = await fake.classify({ ...classifyInput, source: { title: 'Other', markdown: 'different' } })
    expect(a.run.input_hash).toBe(b.run.input_hash)
    expect(a.run.input_hash).not.toBe(c.run.input_hash)
  })
})
