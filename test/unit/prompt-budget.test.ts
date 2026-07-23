// Prompt size budgets — the cost gate.
//
// A system prompt is sent on EVERY call of its kind, forever. Adding a
// paragraph to synthesize.v1 is not a free clarification: it is a permanent
// line item on every ingest of every source, in every deployment. Nothing else
// in the suite notices — the golden snapshots pin the bytes (so a change is
// *visible* in review) but say nothing about whether the prompt has quietly
// tripled since v0.1.
//
// So these ceilings are not style rules; they are the point where "just one
// more instruction" has to become a deliberate decision with a number attached.
// Raising one is fine — it is one line in a diff, and that is exactly the
// conversation this test exists to force.
//
// Measured with the same estimator the ingest budget uses, so the numbers here
// mean what WIKIKIT_MAX_INGEST_TOKENS means.
import { describe, expect, test } from 'bun:test'
import { estimateTokens } from '../../src/ingest/chunk.ts'
import * as answerV1 from '../../src/llm/prompts/answer.v1.ts'
import * as classifyV1 from '../../src/llm/prompts/classify.v1.ts'
import * as distillV1 from '../../src/llm/prompts/distill.v1.ts'
import * as synthesizeV1 from '../../src/llm/prompts/synthesize.v1.ts'
import * as adjudicateV1 from '../../src/llm/prompts/adjudicate.v1.ts'

// Ceilings sit ~30% above the committed prompts: enough headroom to edit a
// sentence without ceremony, tight enough that a doubling cannot slip through.
const BUDGETS: [string, string, number][] = [
  ['classify.v1', classifyV1.system, 380],
  ['synthesize.v1', synthesizeV1.system, 1100],
  ['answer.v1', answerV1.system, 600],
  ['distill.v1', distillV1.system, 660],
  ['adjudicate.v1', adjudicateV1.system, 300],
]

describe('system prompt token budgets', () => {
  for (const [name, system, budget] of BUDGETS) {
    test(`${name} stays within ${budget} tokens`, () => {
      const tokens = estimateTokens(system)
      expect(
        tokens,
        `${name} is ~${tokens} tokens, over its ${budget} budget. This prompt is billed on every ` +
          `call of its kind — if the growth is justified, raise the budget in this file deliberately.`,
      ).toBeLessThanOrEqual(budget)
    })
  }

  // The renderers must not smuggle the static instructions into the per-call
  // turn: only a byte-stable system part can be a cache prefix, so text that
  // belongs in `system` but lives in `render()` is billed at full rate on
  // every call instead of cache-read rate. (E2E asserts the wire placement;
  // this asserts the split at the source.)
  test('renderers carry no static instruction text — that belongs in the cached system part', () => {
    const rendered = {
      'classify.v1': classifyV1.render({ source: { title: 't', markdown: 'm' }, conceptIndex: [] }),
      'answer.v1': answerV1.render({ question: 'q', evidence: [] }),
      'distill.v1': distillV1.render({ transcript: 't' }),
    }
    for (const [name, text] of Object.entries(rendered)) {
      // A render() for trivial input is scaffolding only (headers, tags, one
      // instruction line). Anything much larger means prose crept in.
      expect(
        estimateTokens(text),
        `${name} render() is large for empty input — is static text leaking out of system?`,
      ).toBeLessThanOrEqual(120)
    }
  })
})
