/**
 * The design tokens, as data.
 *
 * They exist in two places by necessity: `index.css` declares them, because
 * only CSS can hand a custom property to Tailwind, and this module states them,
 * because only TypeScript can hand them to an SVG `stroke` or a chart series.
 * A drift test compares the two and fails the build on a disagreement — which
 * is the only reason two copies are allowed to exist.
 *
 * The NAMES are shadcn's, so a component pasted from the registry works
 * unmodified. The VALUES are the contract's — see contract/cockpit-ui.css,
 * whose bytes these restate.
 */
export const TOKENS = {
  light: {
    background: '#ffffff',
    foreground: '#020817',
    surface: '#ffffff',
    card: '#ffffff',
    'card-foreground': '#020817',
    popover: '#ffffff',
    'popover-foreground': '#020817',
    primary: '#0f172a',
    'primary-foreground': '#f8fafc',
    secondary: '#f1f5f9',
    'secondary-foreground': '#0f172a',
    muted: '#f1f5f9',
    'muted-foreground': '#64748b',
    accent: '#2563eb',
    'accent-foreground': '#ffffff',
    destructive: '#dc2626',
    warning: '#d97706',
    success: '#059669',
    border: '#e2e8f0',
    input: '#e2e8f0',
    ring: '#2563eb',
    'chart-1': '#2563eb',
    'chart-2': '#059669',
    'chart-3': '#d97706',
    'chart-4': '#7c3aed',
    'chart-5': '#dc2626',
    sidebar: '#ffffff',
    'sidebar-foreground': '#020817',
    'sidebar-primary': '#0f172a',
    'sidebar-primary-foreground': '#f8fafc',
    'sidebar-accent': '#f1f5f9',
    'sidebar-accent-foreground': '#0f172a',
    'sidebar-border': '#e2e8f0',
    'sidebar-ring': '#2563eb',
  },
  dark: {
    background: '#020817',
    foreground: '#f8fafc',
    surface: '#0f172a',
    card: '#0f172a',
    'card-foreground': '#f8fafc',
    popover: '#0f172a',
    'popover-foreground': '#f8fafc',
    primary: '#f8fafc',
    'primary-foreground': '#0f172a',
    secondary: '#1e293b',
    'secondary-foreground': '#f8fafc',
    muted: '#1e293b',
    'muted-foreground': '#94a3b8',
    accent: '#60a5fa',
    'accent-foreground': '#020817',
    destructive: '#f87171',
    warning: '#fbbf24',
    success: '#34d399',
    border: '#334155',
    input: '#334155',
    ring: '#60a5fa',
    'chart-1': '#60a5fa',
    'chart-2': '#34d399',
    'chart-3': '#fbbf24',
    'chart-4': '#c4b5fd',
    'chart-5': '#f87171',
    sidebar: '#0f172a',
    'sidebar-foreground': '#f8fafc',
    'sidebar-primary': '#f8fafc',
    'sidebar-primary-foreground': '#0f172a',
    'sidebar-accent': '#1e293b',
    'sidebar-accent-foreground': '#f8fafc',
    'sidebar-border': '#334155',
    'sidebar-ring': '#60a5fa',
  },
} as const

export type TokenName = keyof typeof TOKENS.light
export type Scheme = keyof typeof TOKENS

/** The corner radius every `--radius-*` step is computed from. */
export const RADIUS = '12px'

/**
 * The domain-state vocabulary, mapped onto the palette rather than onto new
 * colours — and onto the SEMANTIC names, never the chart series (CUI-SEV-1).
 * `destructive`, `warning`, `success` and `accent` share hexes with `chart-5`,
 * `chart-3`, `chart-2` and `chart-1`, and that is exactly why the names matter:
 * a status wearing a chart's name reads as though a graph leaked into a pill.
 *
 * `unknown` is the state every dashboard gets wrong. A claim nothing has
 * verified, an ingest nobody has run yet, a concept with no revision — none of
 * those are good and none are bad. They are unmeasured, and they get the muted
 * tone: visibly present, visibly not a verdict.
 */
export const STATE_TOKEN = {
  /** Settled, and the outcome is the wanted one: approved, verified, delivered. */
  succeeded: 'success',
  /** Settled, and the outcome is not: rejected, disputed, failed. */
  failed: 'destructive',
  /** In motion right now: an ingest running, a search executing. */
  running: 'accent',
  /** Stopped until a human acts: a change awaiting review, changes requested. */
  blocked: 'warning',
  /** Nothing has been measured or decided: queued, cancelled, deprecated. */
  unknown: 'muted-foreground',
} as const

export type DomainState = keyof typeof STATE_TOKEN

/**
 * Which of the five states each domain status string is. One table, so the
 * changes queue, the ingest monitor and a page's claims panel cannot each
 * invent their own reading of `pending`.
 *
 * `deprecated` and `cancelled` are deliberately `unknown`, not `failed`:
 * somebody withdrew the question, nothing answered it wrongly. `rejected` and
 * `disputed` ARE `failed` — a judgement was made and the answer was no, and a
 * queue has to show that differently from a question nobody answered.
 */
export const STATUS_STATE: Record<string, DomainState> = {
  // change proposals: pending | approved | rejected | failed | split.
  // `split` is terminal and neither good nor bad — the parent's concepts were
  // dealt out to children and the parent itself can never move again.
  pending: 'blocked',
  approved: 'succeeded',
  rejected: 'failed',
  split: 'unknown',
  // ingest jobs: queued | running | done | failed | quota_blocked | captured
  // | discarded. `quota_blocked` is `blocked`, not `failed`: nothing went
  // wrong, the job is parked until its resume_at and the worker puts it back
  // in the queue. `captured` is `blocked` for the review-queue reason —
  // stopped until a human acts. `discarded` is `unknown` like `split`:
  // terminal and neither good nor bad.
  queued: 'unknown',
  running: 'running',
  done: 'succeeded',
  failed: 'failed',
  quota_blocked: 'blocked',
  captured: 'blocked',
  discarded: 'unknown',
  // claims — what a page asserts, and how well it is evidenced:
  // proposed | draft | verified | disputed | deprecated.
  verified: 'succeeded',
  proposed: 'blocked',
  draft: 'unknown',
  disputed: 'failed',
  deprecated: 'unknown',
  // concept revisions and decisions: proposed | current | superseded | rejected.
  current: 'succeeded',
  active: 'succeeded',
  superseded: 'unknown',
  removed: 'unknown',
  // webhook deliveries
  delivered: 'succeeded',
  circuit_open: 'failed',
}

/**
 * A pending change that a reviewer bounced back to its author.
 *
 * `changes_requested` is a BOOLEAN on a still-pending proposal, not a status of
 * its own — which is exactly why it needs naming here. Rendered as plain
 * `pending`, a change somebody has already read and sent back looks identical
 * to one nobody has opened, and the queue stops telling a reviewer where their
 * attention is still needed.
 */
export const CHANGES_REQUESTED_STATE: DomainState = 'blocked'

/**
 * Lint severity, mapped the same way. Kept separate from STATUS_STATE because
 * `error` and `warning` are severities, not lifecycle states, and folding them
 * into one table is how `warning` ends up meaning "waiting for a human" on one
 * page and "something is wrong" on the next.
 */
export const SEVERITY_STATE: Record<string, DomainState> = {
  error: 'failed',
  warning: 'blocked',
  info: 'running',
}

/** `var(--success)` — the form a stroke, fill or chart series needs. */
export function tokenVar(name: TokenName): string {
  return `var(--${name})`
}

export function stateVar(state: DomainState): string {
  return tokenVar(STATE_TOKEN[state])
}
