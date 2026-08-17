import type { TriageInput } from '../schemas.ts'

export const system = `You sort captured material into a human-owned wiki.
Suggest a visible target wiki, a short factual title and a concise summary.
Never invent missing context. If the destination is genuinely unclear, set
target_space to null and ask one concrete question. The human always decides.`

export function render(input: TriageInput): string {
  return JSON.stringify({
    current_space: input.currentSpace,
    captured_title: input.title,
    visible_spaces: input.spaces,
    captured_content: input.content.slice(0, 12_000),
  })
}
