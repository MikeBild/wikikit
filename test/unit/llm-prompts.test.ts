// Prompt golden tests — prompt regression = product regression.
//
// The snapshots pin the EXACT bytes of every system prompt and every rendered
// user turn, so any change to a prompt is a visible, reviewed diff here.
// input_hash values in wk_agent_runs derive from these bytes, so silent drift
// would also corrupt dedup/audit semantics. Once the product ships, a
// meaningful prompt change is a new versioned file (v2) rather than an edit —
// pre-release the prompt is edited in place and this snapshot regenerated.
import { describe, expect, test } from 'bun:test'
import { PROMPT_VERSIONS } from '../../src/llm/prompts/index.ts'
import * as classifyV2 from '../../src/llm/prompts/classify.v2.ts'
import * as synthesizeV3 from '../../src/llm/prompts/synthesize.v3.ts'
import * as decisionsV1 from '../../src/llm/prompts/decisions.v1.ts'
import * as answerV1 from '../../src/llm/prompts/answer.v1.ts'
import * as distillV1 from '../../src/llm/prompts/distill.v1.ts'
import * as adjudicateV1 from '../../src/llm/prompts/adjudicate.v1.ts'
import type {
  AdjudicateInput,
  AnswerInput,
  ClassifyInput,
  DistillInput,
  ExtractDecisionsInput,
  SynthesizeInput,
} from '../../src/llm/schemas.ts'

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
// Meeting source: exercises the decision-mining branch (the render appends a
// mining instruction only when sourceKind === 'meeting').
const synthesizeInputMeeting: SynthesizeInput = {
  concept: { slug: 'okf-adoption', title: 'OKF Adoption', currentMarkdown: null },
  source: {
    id: '3d1f8a52-0000-4000-8000-000000000003',
    title: 'Architecture sync 2026-07-10',
    markdown: 'We decided to adopt OKF v0.1 as the export format going forward.',
  },
  predicates: ['is', 'has_status'],
  sourceKind: 'meeting',
}

const answerInput: AnswerInput = {
  question: 'Is OKF production ready?',
  evidence: [
    { kind: 'concept', slug: 'open-knowledge-format', text: 'OKF is a draft specification at v0.1.', status: null },
    { kind: 'claim', slug: 'open-knowledge-format', text: 'okf has_status production-ready', status: 'disputed' },
  ],
}

const answerInputNoEvidence: AnswerInput = { question: 'What is the meaning of life?', evidence: [] }

const distillInput: DistillInput = {
  transcript: 'human: no — always let CI deploy, never by hand\nassistant: understood, updating the runbook',
}

const adjudicateInput: AdjudicateInput = {
  subject: 'open-knowledge-format',
  predicate: 'has_status',
  existing: { object: 'production-ready', quote: 'OKF is ready for production use.' },
  incoming: { object: 'draft-v0.1', quote: null },
}

// Decision extraction: the branch that matters is whether the space already
// holds decisions — that list is what makes duplicate marking possible.
const extractDecisionsInputEmpty: ExtractDecisionsInput = {
  source: { title: 'Weekly sync', markdown: '# Weekly sync\n\nWe decided to ship the draft on Friday.' },
  sourceKind: 'meeting',
  existingDecisions: [],
}

const extractDecisionsInput: ExtractDecisionsInput = {
  source: { title: null, markdown: 'We decided to ship the draft on Friday, as agreed last week.' },
  sourceKind: 'meeting',
  existingDecisions: [
    { slug: 'ship-on-friday', title: 'Ship on Friday', decision: 'Releases go out on Friday mornings.' },
    { slug: 'no-direct-mqtt', title: 'No direct MQTT', decision: 'Integrate over standard webhooks only.' },
  ],
}

describe('prompt version constants', () => {
  test('PROMPT_VERSIONS match the per-file version exports', () => {
    expect(PROMPT_VERSIONS.classify).toBe(classifyV2.version)
    expect(PROMPT_VERSIONS.synthesize).toBe(synthesizeV3.version)
    expect(PROMPT_VERSIONS.decisions).toBe(decisionsV1.version)
    expect(PROMPT_VERSIONS.answer).toBe(answerV1.version)
    expect(PROMPT_VERSIONS.distill).toBe(distillV1.version)
    expect(PROMPT_VERSIONS.adjudicate).toBe(adjudicateV1.version)
  })

  test('versions follow the <kind>.v<N> convention', () => {
    for (const [kind, version] of Object.entries(PROMPT_VERSIONS)) {
      expect(version).toMatch(new RegExp(`^${kind}\\.v\\d+$`))
    }
  })
})

describe('golden snapshots', () => {
  test('classify.v2 system prompt', () => {
    expect(classifyV2.system).toMatchSnapshot()
  })
  test('classify.v2 render', () => {
    expect(classifyV2.render(classifyInput)).toMatchSnapshot()
  })
  test('classify.v2 render with empty concept index and null title', () => {
    expect(classifyV2.render(classifyInputEmptyIndex)).toMatchSnapshot()
  })

  test('synthesize.v3 system prompt', () => {
    expect(synthesizeV3.system).toMatchSnapshot()
  })
  test('synthesize.v3 render for existing concept', () => {
    expect(synthesizeV3.render(synthesizeInput)).toMatchSnapshot()
  })
  test('synthesize.v3 render for new concept', () => {
    expect(synthesizeV3.render(synthesizeInputNewConcept)).toMatchSnapshot()
  })
  test('synthesize.v3 render for meeting source', () => {
    expect(synthesizeV3.render(synthesizeInputMeeting)).toMatchSnapshot()
  })

  test('decisions.v1 system prompt', () => {
    expect(decisionsV1.system).toMatchSnapshot()
  })
  test('decisions.v1 render with no existing decisions', () => {
    expect(decisionsV1.render(extractDecisionsInputEmpty)).toMatchSnapshot()
  })
  test('decisions.v1 render with existing decisions to compare against', () => {
    expect(decisionsV1.render(extractDecisionsInput)).toMatchSnapshot()
  })

  test('answer.v1 system prompt', () => {
    expect(answerV1.system).toMatchSnapshot()
  })
  test('answer.v1 render with two-tier evidence', () => {
    expect(
      answerV1.render({
        ...answerInput,
        evidence: [
          ...answerInput.evidence,
          {
            kind: 'source_chunk',
            slug: null,
            source_id: '00000000-0000-4000-8000-000000000042',
            text: 'Source: Meeting notes\n## Rollout\nThe rollout was postponed to Q3.',
            status: null,
          },
        ],
      }),
    ).toMatchSnapshot()
  })
  test('answer.v1 render with empty evidence', () => {
    expect(answerV1.render(answerInputNoEvidence)).toMatchSnapshot()
  })

  test('distill.v1 system prompt', () => {
    expect(distillV1.system).toMatchSnapshot()
  })
  test('distill.v1 render', () => {
    expect(distillV1.render(distillInput)).toMatchSnapshot()
  })

  test('adjudicate.v1 system prompt', () => {
    expect(adjudicateV1.system).toMatchSnapshot()
  })
  test('adjudicate.v1 render', () => {
    expect(adjudicateV1.render(adjudicateInput)).toMatchSnapshot()
  })

  // Charter steering: a set charter adds a `## Space guidance` section to the
  // rendered USER turn (never the cached system block).
  const charter = '# Payments space\n\nEmphasise decisions with rationale. Voice: terse, German.'
  test('classify.v2 render without charter omits the Space guidance section', () => {
    expect(classifyV2.render(classifyInput)).not.toContain('## Space guidance')
  })
  test('synthesize.v3 render without charter omits the Space guidance section', () => {
    expect(synthesizeV3.render(synthesizeInput)).not.toContain('## Space guidance')
  })
  test('classify.v2 render with charter (Space guidance section)', () => {
    const rendered = classifyV2.render({ ...classifyInput, charter })
    expect(rendered).toContain('## Space guidance')
    expect(rendered).toMatchSnapshot()
  })
  test('synthesize.v3 render with charter (Space guidance section)', () => {
    const rendered = synthesizeV3.render({ ...synthesizeInput, charter })
    expect(rendered).toContain('## Space guidance')
    expect(rendered).toMatchSnapshot()
  })
})

describe('render determinism', () => {
  // input_hash = sha256(version + system + rendered): rendering must be a
  // pure function of its input or hashes (and dedup) become nondeterministic.
  test('same input renders byte-identical output', () => {
    expect(classifyV2.render(classifyInput)).toBe(classifyV2.render(classifyInput))
    expect(synthesizeV3.render(synthesizeInput)).toBe(synthesizeV3.render(synthesizeInput))
    expect(decisionsV1.render(extractDecisionsInput)).toBe(decisionsV1.render(extractDecisionsInput))
    expect(answerV1.render(answerInput)).toBe(answerV1.render(answerInput))
    expect(adjudicateV1.render(adjudicateInput)).toBe(adjudicateV1.render(adjudicateInput))
  })
})
