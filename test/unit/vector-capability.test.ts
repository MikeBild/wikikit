// Boot-time reporting of the optional hybrid ranker.
// Hybrid retrieval needs two independent halves — a configured embedding
// provider and the pgvector schema objects — and exactly one of the four
// pairings is a misconfiguration: a provider configured against a host that
// has no extension. That deployment looks equipped from its environment and
// produces no embeddings, so it is the only one that may interrupt. None of
// the four may stop the server.
import { describe, expect, test } from 'bun:test'
import { reportVectorCapability } from '../../src/app.ts'
import { createLogger } from '../../src/logger.ts'

function capture() {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({ level: 'debug', write: (line: string) => void lines.push(JSON.parse(line)) })
  return { lines, logger }
}

function report(state: { embeddingConfigured: boolean; available: boolean }) {
  const { lines, logger } = capture()
  reportVectorCapability(logger, state)
  return lines
}

describe('reportVectorCapability', () => {
  test('warns only when a provider is configured and pgvector is absent', () => {
    const warned = report({ embeddingConfigured: true, available: false }).filter((line) => line.level === 'warn')

    expect(warned.length).toBe(1)
    // The message must name the consequence, not the symptom — an operator
    // reading it should learn what the wiki is now doing, not what a probe returned.
    expect(warned[0]!.msg).toContain('retrieval stays lexical')
    expect(warned[0]!.msg).toContain('no embeddings are produced')
  })

  test('stays silent about misconfiguration in every other pairing', () => {
    for (const state of [
      { embeddingConfigured: false, available: false },
      { embeddingConfigured: false, available: true },
      { embeddingConfigured: true, available: true },
    ]) {
      expect(report(state).filter((line) => line.level === 'warn')).toEqual([])
    }
  })

  test('reports an available extension at info, with the other half named', () => {
    const configured = report({ embeddingConfigured: true, available: true })
    expect(configured.length).toBe(1)
    expect(configured[0]!.level).toBe('info')
    expect(configured[0]!.hybrid_retrieval).toBe(true)

    // Available but unconfigured is not a problem and not a warning: the
    // objects exist, nothing is degraded, hybrid is simply not asked for.
    const unconfigured = report({ embeddingConfigured: false, available: true })
    expect(unconfigured.length).toBe(1)
    expect(unconfigured[0]!.level).toBe('info')
    expect(unconfigured[0]!.hybrid_retrieval).toBe(false)
  })

  test('says nothing at all when neither half is present', () => {
    // The shipped default. A keyless, pgvector-less install is the designed
    // floor, and a boot log that flagged it would cry wolf on every deployment.
    expect(report({ embeddingConfigured: false, available: false })).toEqual([])
  })
})
