import { describe, expect, test } from 'bun:test'
import { generateWithLanguageRepair, isGeneratedLanguage } from '../../src/llm/language.ts'
import { LlmOutputInvalidError, type LlmResult } from '../../src/llm/provider.ts'

function result(text: string): LlmResult<string> {
  return {
    output: text,
    run: {
      model: 'fake',
      prompt_version: 'test.v1',
      input_hash: text,
      usage: { input_tokens: 1, output_tokens: 1 },
      duration_ms: 1,
    },
  }
}

describe('generated-language boundary', () => {
  test('accepts German technical prose and rejects an English page with a German token', () => {
    expect(
      isGeneratedLanguage(
        'Die Architektur verwendet MCP und mehrere Workflows für autonome Agenten. Technische Namen bleiben unverändert.',
        'de',
      ),
    ).toBe(true)
    expect(
      isGeneratedLanguage(
        'This project is an MCP server and it provides workflow tools for autonomous agents für teams.',
        'de',
      ),
    ).toBe(false)
  })

  test('runs exactly one marked repair and returns the repaired output', async () => {
    const repairs: boolean[] = []
    const attempts: string[] = []
    const generated = await generateWithLanguageRepair({
      language: 'de',
      generate: async (repair) => {
        repairs.push(repair)
        return result(
          repair
            ? 'Das Projekt verwendet einen MCP-Server und bietet Werkzeuge für Agenten.'
            : 'The project is an MCP server and provides tools for agents.',
        )
      },
      text: (output) => output,
      onAttempt: (attempt) => attempts.push(attempt.output),
    })

    expect(repairs).toEqual([false, true])
    expect(attempts).toHaveLength(2)
    expect(generated.result.output).toStartWith('Das Projekt')
  })

  test('fails after the second language violation', async () => {
    let calls = 0
    await expect(
      generateWithLanguageRepair({
        language: 'de',
        generate: async () => {
          calls += 1
          return result('The project is an MCP server and provides tools for agents.')
        },
        text: (output) => output,
      }),
    ).rejects.toBeInstanceOf(LlmOutputInvalidError)
    expect(calls).toBe(2)
  })
})
