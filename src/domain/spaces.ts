import type { Db } from '../db/postgres.ts'
import { seedDefaultBriefing, type DefaultBriefing } from '../schedule.ts'
import { NotFoundError, ValidationError } from './errors.ts'
import { isoString } from './sources.ts'

export interface Space {
  id: string
  slug: string
  name: string
  settings: Record<string, unknown>
  epoch: number
  created_at: string
  updated_at: string
}

interface SpaceRow {
  id: string
  slug: string
  name: string
  settings: Record<string, unknown>
  epoch: number | string
  created_at: Date | string
  updated_at: Date | string
}

function toSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    settings: row.settings ?? {},
    epoch: Number(row.epoch),
    created_at: isoString(row.created_at),
    updated_at: isoString(row.updated_at),
  }
}

export async function createSpace(
  db: Db,
  args: { slug: string; name: string; settings?: Record<string, unknown> },
  defaultBriefing?: DefaultBriefing | null,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<Space> {
  try {
    const [row] = await db.insert<SpaceRow>('wk_spaces', {
      slug: args.slug,
      name: args.name,
      settings: JSON.stringify({ environment: 'production', ...(args.settings ?? {}) }),
    })
    const space = toSpace(row!)
    await seedDefaultBriefing(db, space.id, defaultBriefing ?? null, logger)
    return space
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new ValidationError(`space slug '${args.slug}' already exists`)
    }
    throw error
  }
}

export async function getSpaceBySlug(db: Db, slug: string): Promise<Space> {
  const [row] = await db.select<SpaceRow>('wk_spaces', { slug: `eq.${slug}`, limit: 1 })
  if (!row) throw new NotFoundError(`space '${slug}' not found`)
  return toSpace(row)
}

export async function listSpaces(db: Db): Promise<Space[]> {
  const rows = await db.select<SpaceRow>('wk_spaces', { order: 'slug.asc', limit: 500 })
  return rows.map(toSpace)
}

export async function updateSpaceSettings(
  db: Db,
  space: Space,
  args: { settings: Record<string, unknown>; replace: boolean },
): Promise<Space> {
  const settings = args.replace ? args.settings : { ...space.settings, ...args.settings }
  const [row] = await db.update<SpaceRow>(
    'wk_spaces',
    { id: `eq.${space.id}` },
    { settings: JSON.stringify(settings), updated_at: new Date() },
  )
  if (!row) throw new NotFoundError(`space '${space.slug}' not found`)
  return toSpace(row)
}
