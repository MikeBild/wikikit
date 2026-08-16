import { LlmOutputInvalidError, type LlmResult } from './provider.ts'

export type GeneratedLanguage = 'en' | 'de'

const GERMAN_WORDS = new Set(
  'aber als auch auf aus bei bis das dem den der des die dies diese dieser dieses durch ein eine einem einen einer eines für gegen hat haben im ist kann können keine mit nach nicht oder ohne seit sind sowie über um und unter vom von vor war waren werden wird wurde wurden zu zum zur zwischen'.split(
    ' ',
  ),
)

const ENGLISH_WORDS = new Set(
  'about after also an and are as at before between but by can could did do does for from has have how in into is it its may not of on or our should that the their these this those through to under using was were what when where which who will with without would'.split(
    ' ',
  ),
)

function languageScores(text: string): { de: number; en: number; letters: number } {
  const withoutTechnicalNoise = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`[^`]*`/g, ' ')
  const tokens = withoutTechnicalNoise.toLocaleLowerCase('de-DE').match(/\p{L}+/gu) ?? []
  let de = 0
  let en = 0
  for (const token of tokens) {
    if (GERMAN_WORDS.has(token)) de += 1
    if (ENGLISH_WORDS.has(token)) en += 1
    if (/[äöüß]/u.test(token)) de += 2
  }
  return { de, en, letters: tokens.length }
}

/**
 * This is deliberately a dominance check rather than full language
 * identification: product names and technical identifiers remain valid in a
 * German page, while an English page with one German heading still fails.
 */
export function isGeneratedLanguage(text: string, language: GeneratedLanguage): boolean {
  const score = languageScores(text)
  if (score.letters < 4) return true
  if (language === 'de') return score.de >= 2 && score.de >= score.en
  return score.en >= 2 && score.en >= score.de
}

export async function generateWithLanguageRepair<T>(args: {
  language?: GeneratedLanguage
  generate: (repair: boolean) => Promise<LlmResult<T>>
  text: (output: T) => string
  onAttempt?: (attempt: LlmResult<T>) => void
}): Promise<{ result: LlmResult<T>; attempts: LlmResult<T>[] }> {
  const first = await args.generate(false)
  args.onAttempt?.(first)
  if (!args.language || isGeneratedLanguage(args.text(first.output), args.language)) {
    return { result: first, attempts: [first] }
  }

  const second = await args.generate(true)
  args.onAttempt?.(second)
  if (isGeneratedLanguage(args.text(second.output), args.language)) {
    return { result: second, attempts: [first, second] }
  }

  throw new LlmOutputInvalidError(`generated prose is not predominantly ${args.language}`, {
    language: args.language,
    attempts: 2,
  })
}
