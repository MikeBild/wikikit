import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import type { IngestPipeline } from '../ingest/pipeline.ts'
import type { LlmProvider } from '../llm/provider.ts'
import { ConflictError, NotFoundError, ValidationError } from './errors.ts'
import { sha256Hex, sourceTitle, summarizeSource } from './sources.ts'

export const zTriageResolution = z.object({
  action: z.enum(['process', 'use_existing', 'leave', 'discard']),
  target_space: z.string().optional(),
  title: z.string().min(1).max(120),
  summary: z.string().max(500),
  question: z.string().max(500).nullable().optional(),
  source_id: z.uuid().optional(),
})

export type TriageResolution = z.infer<typeof zTriageResolution>

export interface TriageSuggestion {
  target_space: string | null
  title: string
  summary: string
  confidence: number
  question: string | null
  duplicate_source_id: string | null
  generated_at: string
}

interface TriageJob {
  id: string
  space_id: string
  status: string
  input: Record<string, unknown> | string
}

export interface TriageSpace {
  id: string
  slug: string
  name: string
  settings: Record<string, unknown>
}

function parseInput(job: TriageJob): Record<string, unknown> {
  return typeof job.input === 'string' ? (JSON.parse(job.input) as Record<string, unknown>) : job.input
}

async function capturedJob(db: Db, id: string): Promise<TriageJob> {
  const [job] = await db.select<TriageJob>('wk_ingest_jobs', { id: `eq.${id}`, limit: 1 })
  if (!job) throw new NotFoundError(`ingest job ${id} not found`)
  if (job.status !== 'captured') {
    throw new ConflictError('ingest_not_captured', `ingest job ${id} is ${job.status}, not captured`)
  }
  return job
}

function contentOf(input: Record<string, unknown>): string {
  for (const key of ['markdown', 'text', 'url']) {
    if (typeof input[key] === 'string' && input[key]) return input[key] as string
  }
  throw new ValidationError('captured ingest has no content')
}

function storedSuggestion(input: Record<string, unknown>): TriageSuggestion | null {
  const parsed = z
    .object({
      target_space: z.string().nullable(),
      title: z.string(),
      summary: z.string(),
      confidence: z.number(),
      question: z.string().nullable(),
      duplicate_source_id: z.uuid().nullable(),
      generated_at: z.string(),
    })
    .safeParse(input.triage)
  return parsed.success ? parsed.data : null
}

export async function getTriageSuggestion(db: Db, id: string): Promise<TriageSuggestion | null> {
  const job = await capturedJob(db, id)
  return storedSuggestion(parseInput(job))
}

export async function suggestTriage(
  db: Db,
  llm: LlmProvider,
  id: string,
  spaces: readonly TriageSpace[],
): Promise<TriageSuggestion> {
  const job = await capturedJob(db, id)
  const input = parseInput(job)
  const content = contentOf(input)
  const current = spaces.find((space) => space.id === job.space_id)
  if (!current) throw new ValidationError('captured ingest belongs to a wiki that is not visible')

  const rawTitle =
    typeof input.raw_title === 'string' ? input.raw_title : typeof input.title === 'string' ? input.title : null
  const contentHash = sha256Hex(content)
  const deterministicTitle = sourceTitle({ title: rawTitle, markdown: content, contentHash }).slice(0, 120)
  let candidate = {
    target_space: current.slug as string | null,
    title: deterministicTitle,
    summary: summarizeSource(content, 500),
    confidence: 0.5,
    question: null as string | null,
  }
  let run: Awaited<ReturnType<LlmProvider['triage']>>['run'] | null = null

  if (llm.configured) {
    const result = await llm.triage({
      currentSpace: current.slug,
      title: rawTitle,
      content,
      spaces: spaces.map((space) => ({
        slug: space.slug,
        name: space.name,
        purpose:
          typeof space.settings.purpose === 'string'
            ? space.settings.purpose
            : typeof space.settings.description === 'string'
              ? space.settings.description
              : null,
      })),
    })
    candidate = result.output
    run = result.run
  }

  const visibleSlugs = new Set(spaces.map((space) => space.slug))
  if (candidate.target_space && !visibleSlugs.has(candidate.target_space)) {
    candidate = {
      ...candidate,
      target_space: null,
      confidence: 0,
      question: 'Which visible wiki should receive this capture?',
    }
  }
  const target = spaces.find((space) => space.slug === candidate.target_space) ?? current
  const [duplicate] = await db.select<{ id: string }>('wk_sources', {
    space_id: `eq.${target.id}`,
    content_hash: `eq.${contentHash}`,
    limit: 1,
  })
  const suggestion: TriageSuggestion = {
    ...candidate,
    duplicate_source_id: duplicate?.id ?? null,
    generated_at: new Date().toISOString(),
  }
  await db.tx(async (tx) => {
    await tx.update(
      'wk_ingest_jobs',
      { id: `eq.${id}`, status: 'eq.captured' },
      { input: JSON.stringify({ ...input, triage: suggestion }) },
      { returning: false },
    )
    if (run) {
      await tx.insert(
        'wk_agent_runs',
        {
          space_id: job.space_id,
          kind: 'triage',
          model: run.model,
          prompt_version: run.prompt_version,
          input_hash: run.input_hash,
          usage: JSON.stringify(run.usage),
          duration_ms: run.duration_ms,
          ingest_job_id: id,
        },
        { returning: false },
      )
    }
  })
  return suggestion
}

export async function resolveTriage(
  db: Db,
  ingest: IngestPipeline,
  id: string,
  rawResolution: TriageResolution,
  spaces: readonly TriageSpace[],
): Promise<void> {
  const resolution = zTriageResolution.parse(rawResolution)
  const job = await capturedJob(db, id)
  const target = resolution.target_space ? spaces.find((space) => space.slug === resolution.target_space) : undefined

  if ((resolution.action === 'process' || resolution.action === 'use_existing') && !target) {
    throw new ValidationError('target_space must name a visible wiki')
  }
  if (resolution.action === 'use_existing') {
    if (!resolution.source_id) throw new ValidationError('source_id is required for use_existing')
    const input = parseInput(job)
    const [source] = await db.select<{ id: string; content_hash: string }>('wk_sources', {
      id: `eq.${resolution.source_id}`,
      space_id: `eq.${target!.id}`,
      limit: 1,
    })
    if (!source) throw new ValidationError('source_id is not in the target wiki')
    if (source.content_hash !== sha256Hex(contentOf(input))) {
      throw new ValidationError('source_id does not match the captured content')
    }
  }

  await ingest.resolveCapture(
    db,
    id,
    resolution.action === 'process'
      ? {
          action: 'process',
          targetSpaceId: target!.id,
          title: resolution.title,
          summary: resolution.summary,
        }
      : resolution.action === 'use_existing'
        ? {
            action: 'use_existing',
            targetSpaceId: target!.id,
            sourceId: resolution.source_id!,
            title: resolution.title,
            summary: resolution.summary,
          }
        : resolution.action === 'leave'
          ? {
              action: 'leave',
              title: resolution.title,
              summary: resolution.summary,
              question: resolution.question ?? null,
            }
          : { action: 'discard', title: resolution.title, summary: resolution.summary },
  )
}
