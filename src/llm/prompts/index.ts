// Prompt version constants (CONTRACTS.md §3.4).
//
// WHY versions are load-bearing: every wk_agent_runs row and every agent_meta
// blob records the prompt_version that produced it, and proposal input_hash
// dedup keys include it. Changing ANY prompt text therefore requires a new
// versioned file (classify.v2.ts, ...) and a bump here — never an in-place
// edit. The golden snapshot tests in test/unit/llm-prompts.test.ts turn an
// accidental in-place edit into a failing CI run (prompt regression =
// product regression).
export const PROMPT_VERSIONS = {
  classify: 'classify.v2', // v1 + optional per-space Charter steering (system unchanged)
  synthesize: 'synthesize.v2', // v1 + optional per-space Charter steering (system unchanged)
  answer: 'answer.v1', // two-tier evidence (approved vs source_evidence)
  distill: 'distill.v1', // coding-agent session transcript → durable rules
  adjudicate: 'adjudicate.v1', // optional Haiku contradiction adjudication (cuttable)
} as const

export type PromptKind = keyof typeof PROMPT_VERSIONS

export * as classifyV2 from './classify.v2.ts'
export * as synthesizeV2 from './synthesize.v2.ts'
export * as answerV1 from './answer.v1.ts'
export * as distillV1 from './distill.v1.ts'
export * as adjudicateV1 from './adjudicate.v1.ts'
