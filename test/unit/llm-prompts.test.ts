// Prompt golden tests — prompt regression = product regression.
//
// The snapshots pin the EXACT bytes of every system prompt and every rendered
// user turn. A diff here means either (a) an accidental in-place edit of a
// versioned prompt (forbidden — add a .v2 file and bump PROMPT_VERSIONS), or
// (b) a deliberate new version, in which case the snapshot update is the
// visible, reviewable artifact of that change. input_hash values in
// wk_agent_runs derive from these bytes, so silent drift would also corrupt
// dedup/audit semantics.
import { describe, expect, test } from 'bun:test'
import { PROMPT_VERSIONS } from '../../src/llm/prompts/index.ts'
import * as classifyV1 from '../../src/llm/prompts/classify.v1.ts'
import * as synthesizeV1 from '../../src/llm/prompts/synthesize.v1.ts'
import * as answerV1 from '../../src/llm/prompts/answer.v1.ts'
import * as adjudicateV1 from '../../src/llm/prompts/adjudicate.v1.ts'
import type { AdjudicateInput, AnswerInput, ClassifyInput, SynthesizeInput } from '../../src/llm/schemas.ts'

// Fixed inputs — deliberately exercising every branch of each render():
// null titles, empty vs populated lists, null quotes/markdown.
const classifyInput: ClassifyInput = {
  source: { title: 'OKF Announcement', markdown: '# OKF\n\nGoogle released the Open Knowledge Format as draft v0.1.' },
  conceptIndex: [
    { slug: 'open-knowledge-format', title: 'Open Knowledge Format', summary: 'An open bundle format for knowledge.' },
    { slug: 'wikikit', title: 'WikiKit', summary: 'A headless AI-native knowledge system.' },
  ],
}

const classifyInputEmptyIndex: ClassifyInput = {
  source: { title: null, markdown: 'Some untitled note.' },
  conceptIndex: [],
}

const synthesizeInput: SynthesizeInput = {
  concept: {
    slug: 'open-knowledge-format',
    title: 'Open Knowledge Format',
    currentMarkdown: '# OKF\n\nOKF is production-ready.',
  },
  source: {
    id: '3d1f8a52-0000-4000-8000-000000000001',
    title: 'OKF Announcement',
    markdown: 'The specification is published as draft v0.1.',
  },
  predicates: ['is', 'has_status', 'published_by', 'depends_on'],
}

const synthesizeInputNewConcept: SynthesizeInput = {
  concept: { slug: 'knowledge-catalog', title: 'Knowledge Catalog', currentMarkdown: null },
  source: {
    id: '3d1f8a52-0000-4000-8000-000000000002',
    title: null,
    markdown: 'The knowledge catalog hosts OKF bundles.',
  },
  predicates: ['is'],
}

const answerInput: AnswerInput = {
  question: 'Is OKF production ready?',
  evidence: [
    { kind: 'concept', slug: 'open-knowledge-format', text: 'OKF is a draft specification at v0.1.', status: null },
    { kind: 'claim', slug: 'open-knowledge-format', text: 'okf has_status production-ready', status: 'disputed' },
  ],
}

const answerInputNoEvidence: AnswerInput = { question: 'What is the meaning of life?', evidence: [] }

const adjudicateInput: AdjudicateInput = {
  subject: 'open-knowledge-format',
  predicate: 'has_status',
  existing: { object: 'production-ready', quote: 'OKF is ready for production use.' },
  incoming: { object: 'draft-v0.1', quote: null },
}

describe('prompt version constants', () => {
  test('PROMPT_VERSIONS match the per-file version exports', () => {
    expect(PROMPT_VERSIONS.classify).toBe(classifyV1.version)
    expect(PROMPT_VERSIONS.synthesize).toBe(synthesizeV1.version)
    expect(PROMPT_VERSIONS.answer).toBe(answerV1.version)
    expect(PROMPT_VERSIONS.adjudicate).toBe(adjudicateV1.version)
  })

  test('versions follow the <kind>.v<N> convention', () => {
    for (const [kind, version] of Object.entries(PROMPT_VERSIONS)) {
      expect(version).toMatch(new RegExp(`^${kind}\\.v\\d+$`))
    }
  })
})

describe('golden snapshots', () => {
  test('classify.v1 system prompt', () => {
    expect(classifyV1.system).toMatchSnapshot()
  })
  test('classify.v1 render', () => {
    expect(classifyV1.render(classifyInput)).toMatchSnapshot()
  })
  test('classify.v1 render with empty concept index and null title', () => {
    expect(classifyV1.render(classifyInputEmptyIndex)).toMatchSnapshot()
  })

  test('synthesize.v1 system prompt', () => {
    expect(synthesizeV1.system).toMatchSnapshot()
  })
  test('synthesize.v1 render for existing concept', () => {
    expect(synthesizeV1.render(synthesizeInput)).toMatchSnapshot()
  })
  test('synthesize.v1 render for new concept', () => {
    expect(synthesizeV1.render(synthesizeInputNewConcept)).toMatchSnapshot()
  })

  test('answer.v1 system prompt', () => {
    expect(answerV1.system).toMatchSnapshot()
  })
  test('answer.v1 render with evidence', () => {
    expect(answerV1.render(answerInput)).toMatchSnapshot()
  })
  test('answer.v1 render with empty evidence', () => {
    expect(answerV1.render(answerInputNoEvidence)).toMatchSnapshot()
  })

  test('adjudicate.v1 system prompt', () => {
    expect(adjudicateV1.system).toMatchSnapshot()
  })
  test('adjudicate.v1 render', () => {
    expect(adjudicateV1.render(adjudicateInput)).toMatchSnapshot()
  })
})

describe('render determinism', () => {
  // input_hash = sha256(version + system + rendered): rendering must be a
  // pure function of its input or hashes (and dedup) become nondeterministic.
  test('same input renders byte-identical output', () => {
    expect(classifyV1.render(classifyInput)).toBe(classifyV1.render(classifyInput))
    expect(synthesizeV1.render(synthesizeInput)).toBe(synthesizeV1.render(synthesizeInput))
    expect(answerV1.render(answerInput)).toBe(answerV1.render(answerInput))
    expect(adjudicateV1.render(adjudicateInput)).toBe(adjudicateV1.render(adjudicateInput))
  })
})
