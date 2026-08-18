import { CONSOLE_LOCALE } from '@/lib/relative-time'
import { SEVERITY_STATE, type DomainState } from '@/lib/tokens'

/**
 * The System page's rules, with no DOM attached.
 *
 * Two of them exist because the SERVER's words and the CONSOLE's words do not
 * line up, and both mismatches are the kind that type-check perfectly and
 * render wrongly:
 *
 *  - `/v1/spaces/{space}/lint` answers `severity: 'error' | 'warn' | 'info'`
 *    (schemas.ts, zLintResponse) while `SEVERITY_STATE` is keyed
 *    `error | warning | info`. A lookup by the wire value misses on every
 *    warning and falls through to the unmeasured tone — so half the linter's
 *    output would render as "nothing has been established here" when in fact
 *    something has, and it is a warning.
 *  - `/.well-known/service-descriptor.json` is documented in ROUTES with a
 *    prose description and NO response schema, so the generated types give it
 *    nothing to check. It is parsed defensively here rather than asserted at
 *    the call site, because the one endpoint whose whole job is to report what
 *    this build is must not be able to blank the page that reports it.
 */

/**
 * The tones `Badge` accepts, restated so this module stays free of JSX.
 *
 * Same deliberate non-derivation as elsewhere in the console: `STATE_TOKEN`
 * maps a state onto a CSS custom property because an SVG stroke needs a colour,
 * and `muted-foreground` is not a badge tone while `destructive` is spelled
 * `danger`. Deriving one table from the other produces an invalid tone the day
 * a token is renamed — which is exactly what the separate `tone` prop exists to
 * make impossible.
 */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'unknown'

const BADGE_TONE: Record<DomainState, Tone> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
}

export function toneFor(state: DomainState): Tone {
  return BADGE_TONE[state]
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

/**
 * The wire severity → the key `SEVERITY_STATE` is written in.
 *
 * One entry, and it is the whole point of the table: `warn` on the wire is
 * `warning` in the token map. Spelled as an alias rather than by adding `warn`
 * to `SEVERITY_STATE`, because that table is shared with the change-proposal
 * lint surface and is checked against the contract by
 * test/unit/cockpit-ui-contract.test.ts — widening it to absorb a spelling
 * would move a translation problem into the vocabulary.
 */
const SEVERITY_KEY: Record<string, string> = { warn: 'warning' }

/** Severity order, worst first. A findings list sorted any other way buries the errors. */
export const LINT_SEVERITIES: readonly string[] = ['error', 'warn', 'info']

const SEVERITY_WORDS: Record<string, { one: string; many: string }> = {
  error: { one: 'Error', many: 'Errors' },
  warn: { one: 'Warning', many: 'Warnings' },
  // "Note", not "Info": an info-level finding is something the linter noticed
  // and nobody has to act on, and "Info" names the level rather than the thing.
  info: { one: 'Note', many: 'Notes' },
}

export interface SeverityStanding {
  one: string
  many: string
  tone: Tone
}

export function severityStanding(severity: string): SeverityStanding {
  const state = SEVERITY_STATE[SEVERITY_KEY[severity] ?? severity] ?? 'unknown'
  // A severity this bundle has never heard of prints ITSELF rather than being
  // folded into one of the three. A word the server means is still a word, and
  // inventing a nicer one for it hides a vocabulary drift the operator would
  // otherwise see and report.
  const words = SEVERITY_WORDS[severity] ?? { one: severity, many: severity }
  return { one: words.one, many: words.many, tone: toneFor(state) }
}

/** The fields of a lint finding this page reads. The response carries `details` as well. */
export interface LintFinding {
  rule: string
  severity: string
  message: { key: string; args: Record<string, unknown>; default_text: string }
  concept_slug?: string
  details?: Record<string, unknown>
}

export interface LintGroup extends SeverityStanding {
  severity: string
  items: LintFinding[]
}

/**
 * Findings, grouped by severity, worst first — and never a group with nothing
 * in it.
 *
 * The counts and the findings arrive as two separate fields, and they can
 * legitimately disagree: `counts` is the census of everything the linter found,
 * while a group here is what there is to READ. Grouping is done off the
 * findings rather than off the counts so a heading can never promise rows the
 * response did not carry.
 *
 * A severity outside the known three lands in its own group at the end rather
 * than being dropped — a finding this console cannot classify is still a
 * finding, and silently discarding it is how a newer server's new severity
 * becomes invisible.
 */
export function groupFindings(findings: readonly LintFinding[]): LintGroup[] {
  const buckets = new Map<string, LintFinding[]>()
  for (const finding of findings) {
    const bucket = buckets.get(finding.severity)
    if (bucket) bucket.push(finding)
    else buckets.set(finding.severity, [finding])
  }
  const order = [...LINT_SEVERITIES, ...[...buckets.keys()].filter((key) => !LINT_SEVERITIES.includes(key))]
  const groups: LintGroup[] = []
  for (const severity of order) {
    const items = buckets.get(severity)
    if (!items || items.length === 0) continue
    groups.push({ severity, items, ...severityStanding(severity) })
  }
  return groups
}

// ---------------------------------------------------------------------------
// What this build says about itself
// ---------------------------------------------------------------------------

export interface ServiceArtifact {
  /** The descriptor's own key: `llms_txt`, `openapi`, … */
  key: string
  /** The file as it is actually served, which is what an operator would go and fetch. */
  label: string
  url: string | null
  sha256: string | null
}

export interface ServiceDescriptor {
  service: string | null
  version: string | null
  artifacts: ServiceArtifact[]
  capabilities: string[]
}

/**
 * The descriptor keys, spelled as the documents they fingerprint.
 *
 * `llms_txt` is a JSON key; `llms.txt` is a file somebody can open. An operator
 * comparing a digest against a deployment does it against the file, so the file
 * is what the row is named.
 */
const ARTIFACT_LABEL: Record<string, string> = {
  llms_txt: 'llms.txt',
  llms_full_txt: 'llms-full.txt',
  agent_guide: 'agent-guide.md',
  openapi: 'openapi.json',
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * The descriptor, read rather than asserted.
 *
 * A build that serves no `llms.txt` omits the key entirely — the handler adds
 * only the artifacts it can actually read from disk, on purpose, so a watcher
 * is never sent to fetch a document that answers 404. That means the shape is
 * genuinely open, and every field here is optional in practice.
 *
 * Junk in produces an EMPTY descriptor rather than a throw: the caller renders
 * that through the empty branch, which says "this build publishes nothing about
 * itself" — a truthful reading of a 200 that carried nothing usable, and one
 * that does not take the version headline down with it.
 */
export function readDescriptor(body: unknown): ServiceDescriptor {
  const source = (body ?? {}) as Record<string, unknown>
  const rawArtifacts = (source.artifacts ?? {}) as Record<string, unknown>
  const artifacts: ServiceArtifact[] = []
  if (rawArtifacts && typeof rawArtifacts === 'object' && !Array.isArray(rawArtifacts)) {
    for (const [key, value] of Object.entries(rawArtifacts)) {
      const entry = (value ?? {}) as Record<string, unknown>
      artifacts.push({
        key,
        label: ARTIFACT_LABEL[key] ?? key,
        url: text(entry.url),
        sha256: text(entry.sha256),
      })
    }
  }
  const capabilities = Array.isArray(source.capabilities)
    ? source.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : []
  return { service: text(source.service), version: text(source.version), artifacts, capabilities }
}

export interface Readiness {
  status: string | null
  version: string | null
}

/** The same treatment for `/ready`, which this page fetches outside the typed client. */
export function readReadiness(body: unknown): Readiness {
  const source = (body ?? {}) as Record<string, unknown>
  return { status: text(source.status), version: text(source.version) }
}

/**
 * What the readiness word means, in the operator's language.
 *
 * Deliberately NOT in `STATUS_STATE`: that table is the database's lifecycle
 * vocabulary — proposals, ingest jobs, claims — and `ready`/`draining` are
 * facts about a process, not rows. Folding them in would put a word no table
 * ever stores into the map every queue reads.
 *
 * `draining` is `blocked`, not `failed`. A draining process is finishing the
 * requests it already has and refusing new ones, which is a graceful shutdown
 * working exactly as designed; painting it red teaches an operator to panic at
 * every deploy.
 */
export function readinessStanding(status: string | null): { label: string; tone: Tone } {
  if (status === 'ready') return { label: 'Taking traffic', tone: toneFor('succeeded') }
  if (status === 'draining') return { label: 'Draining', tone: toneFor('blocked') }
  return { label: status ?? 'Unknown', tone: toneFor('unknown') }
}

/**
 * Two versions from one installation that disagree.
 *
 * `/ready` and the descriptor both report `config.version`, so within ONE
 * process they cannot differ. Behind a load balancer mid-rollout they can, and
 * that is worth saying out loud: the two answers came from two builds, and
 * every other number on this page came from one of them without saying which.
 * Silent about the drift, the page reports a mixture as though it were a state.
 */
export function versionsDisagree(ready: string | null, descriptor: string | null): boolean {
  if (!ready || !descriptor) return false
  return ready !== descriptor
}

/** A digest, short enough to read and long enough to compare. `—` when none came. */
export function shortDigest(sha256: string | null | undefined): string {
  if (!sha256) return '—'
  return sha256.length > 12 ? `${sha256.slice(0, 12)}…` : sha256
}

// ---------------------------------------------------------------------------
// What this installation counts as a reference target
// ---------------------------------------------------------------------------

/**
 * What the markers DO, said once and in one sentence.
 *
 * Without it the card is a list of opaque strings, and a list of opaque strings
 * is the same defect one surface further on: an operator can read WHICH markers
 * are honoured and still not know that honouring one is what takes a page out
 * of the evidence column and out of the linter's fault rules. It lives here
 * rather than inline in the JSX so the sentence is provable — it is the only
 * part of this card that is an assertion about the SERVER's behaviour, and it
 * has to keep matching it.
 */
export const SCAFFOLDING_EFFECT =
  'A page whose revision carries one of these markers is treated as a reference target: the index does not measure its evidence, and the linter’s fault rules skip it.'

/**
 * The provenances `/v1/installation/knowledge-config` reports — two of them.
 *
 * Spelled as a tuple rather than as a bare union so the set is a value a test
 * can hold against `zScaffoldingKindOrigin` in src/http/schemas.ts, which is
 * what the server can actually send. Nothing else holds the two together, and
 * the console has already been wrong about this once: a third `fallback`
 * provenance survived here for a whole release after the server stopped being
 * able to send it, because a console state nobody can reach still type-checks
 * and still renders.
 *
 * Exhaustive, and deliberately not widened to `string`. `originStanding` takes
 * whatever the server sent and this list decides which of those the console
 * recognises; a widened type would let a provenance a newer server invents pass
 * as a known one and render as an unlabelled blank.
 */
export const MARKER_ORIGINS = ['built_in', 'configured'] as const
export type MarkerOrigin = (typeof MARKER_ORIGINS)[number]

/**
 * The response, named structurally rather than imported from `api/schema.d.ts`.
 *
 * Same reason as `UsageMetric` above: a rule that can be exercised from a
 * two-field literal is a rule a test can state cases for. The call site passes
 * the generated type, so the real shape is still checked by the compiler.
 */
export interface ScaffoldingMarker {
  kind: string
  origin: MarkerOrigin
}

export interface KnowledgeConfig {
  scaffolding_kinds: {
    /** The environment variable, as the SERVER names it. Never restated here. */
    env: string
    /** Whether the variable was written at all — not derivable from `items`. */
    configured: boolean
    items: readonly ScaffoldingMarker[]
  }
}

export interface OriginStanding {
  origin: string
  /** The word, because a badge may never carry the fact by colour alone (CUI-A11Y-5). */
  label: string
  tone: Tone
  /** What an operator seeing this provenance can actually do about it. */
  meaning: string
}

/**
 * Provenance, in the operator's language — and the reason this card exists at
 * all rather than a bare list.
 *
 * The first question on reading an unexpected marker is "did I set that, or did
 * it come with the product". Two provenances, two different next moves: WikiKit
 * writes `built_in` itself and honours it whatever the configuration says,
 * while a `configured` marker is here because somebody on this installation
 * wrote it down, and can be taken away the same way.
 *
 * There is no third, "nobody here chose this" state. It was reachable only
 * while WikiKit shipped a marker set as a default; the default is gone, so
 * everything not built in is now necessarily something the operator declared.
 */
const ORIGIN_STANDING: Record<MarkerOrigin, Omit<OriginStanding, 'origin'>> = {
  built_in: {
    label: 'Comes with WikiKit',
    tone: 'neutral',
    meaning: 'WikiKit writes this marker itself and always honours it. Configuration cannot remove it.',
  },
  configured: {
    label: 'Set on this installation',
    tone: 'accent',
    meaning: 'Somebody named this marker in this installation’s own configuration.',
  },
}

/**
 * A provenance this bundle has never heard of prints ITSELF, exactly as an
 * unknown lint severity does: a newer server that grows a third origin must not
 * have it silently rendered as one of the two, and least of all as the
 * reassuring one.
 */
export function originStanding(origin: string): OriginStanding {
  const known = ORIGIN_STANDING[origin as MarkerOrigin]
  if (known) return { origin, ...known }
  return {
    origin,
    label: origin,
    tone: 'unknown',
    meaning: 'This build reported a provenance this console does not know. The marker is honoured all the same.',
  }
}

/**
 * A row carries `origin` as a plain string rather than as `MarkerOrigin`: it is
 * whatever the server sent, and `originStanding` is what decides whether this
 * bundle recognises it.
 */
export interface MarkerRow extends OriginStanding {
  kind: string
}

/**
 * The markers, each carrying where it came from, in the order the server sent
 * them.
 *
 * NOT re-sorted. The response documents its order as the one the reads apply,
 * and a console that regroups by provenance would be showing an order no part
 * of WikiKit uses.
 */
export function scaffoldingMarkers(config: KnowledgeConfig): MarkerRow[] {
  return config.scaffolding_kinds.items.map((marker) => ({ ...marker, ...originStanding(marker.origin) }))
}

/**
 * One entry per provenance actually present, first appearance first.
 *
 * The badges say which; this says what each one means, once. Per-row it would
 * repeat the same sentence under every configured marker, and a sentence
 * printed five times is a sentence nobody reads.
 */
export function originLegend(config: KnowledgeConfig): OriginStanding[] {
  const seen = new Set<string>()
  const legend: OriginStanding[] = []
  for (const marker of config.scaffolding_kinds.items) {
    if (seen.has(marker.origin)) continue
    seen.add(marker.origin)
    legend.push(originStanding(marker.origin))
  }
  return legend
}

/**
 * Whether the variable was written — the one fact the list cannot carry.
 *
 * An installation that configures exactly the built-in marker reports items
 * that are all `built_in`, which is character-for-character what an
 * installation that configured nothing reports. The server sends `configured`
 * for precisely that case, and a card that derived this sentence from the rows
 * would tell one of those two operators the opposite of the truth.
 */
export function declarationSentence(config: KnowledgeConfig): string {
  const { env, configured } = config.scaffolding_kinds
  return configured
    ? `${env} is set on this installation.`
    : `${env} is not set here, so the markers below are the ones WikiKit ships.`
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * A usage-stats metric, structurally. The response carries `value_kind` and
 * three optional sample fields as well; naming only what this module reads
 * keeps the rule testable from a two-field literal.
 */
export interface UsageMetric {
  value: number
  value_state: 'observed' | 'zero' | 'missing'
}

/**
 * The number a usage metric actually measured, or null when it measured nothing.
 *
 * `value` is 0 in both the `zero` and the `missing` case — the server sends the
 * discriminator precisely because the two are different facts. "No request
 * arrived in this window" is a measurement; "nothing sampled this window" is
 * not, and only the second gets an em dash (CUI-SEV-2).
 */
export function measured(metric: UsageMetric | null | undefined): number | null {
  if (!metric) return null
  return metric.value_state === 'missing' ? null : metric.value
}

/** A count, in the console's own locale — or `—` when nobody sent one. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString(CONSOLE_LOCALE)
}

/**
 * A ratio metric as a percentage.
 *
 * The server sends `value: 0, value_state: 'missing'` when the denominator was
 * zero, which is the case this exists for: "0% of requests succeeded" and "no
 * request was made" are opposite readings of the same zero, and only one of
 * them is true.
 */
export function percent(metric: UsageMetric | null | undefined): string {
  const value = measured(metric)
  if (value === null || !Number.isFinite(value)) return '—'
  return `${Math.round(value * 100)}%`
}

/** A duration in milliseconds, at the coarseness a person would say it. */
export function durationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60_000)} min`
}

/**
 * The average duration of an LLM call, or `—` when none was made.
 *
 * The LLM ledger answers `{calls: 0, duration_ms: {total: 0, avg: 0, max: 0}}`
 * for a quiet window, and `avg: 0` there means "no sample", not
 * "instantaneous". `calls` is the only field that can tell those apart, which
 * is why it is the first argument rather than an implication of the second.
 */
export function averageMs(calls: number | null | undefined, avg: number | null | undefined): string {
  if (!calls || calls <= 0) return '—'
  return durationMs(avg)
}

/** Known configured spend. A wholly unpriced window is unknown, never free. */
export function llmCost(
  value: number | null | undefined,
  calls: number,
  unpricedCalls: number,
  locale = CONSOLE_LOCALE,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (calls > 0 && calls === unpricedCalls && value === 0) return '—'
  const digits = value > 0 && value < 0.01 ? 4 : 2
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

export function llmCacheRatio(value: number | null | undefined, locale = CONSOLE_LOCALE): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value)
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * "the last 24 hours" — the window a statistic describes, in the reader's
 * words rather than as two ISO instants.
 *
 * Read from the response's own `from`/`to` and never assumed. This page asks
 * for the server's default window; the moment it passes a range, a hard-coded
 * caption under the numbers would contradict them. Returns null for a window
 * that makes no sense, so the caller prints the numbers without a sentence
 * rather than printing a wrong one.
 */
export function windowLabel(from: string, to: string): string | null {
  const start = new Date(from).valueOf()
  const end = new Date(to).valueOf()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const span = end - start
  if (span < 2 * HOUR_MS) {
    const minutes = Math.round(span / MINUTE_MS)
    return minutes === 60 ? 'the last hour' : `the last ${minutes} minutes`
  }
  if (span < 2 * DAY_MS) return `the last ${Math.round(span / HOUR_MS)} hours`
  return `the last ${Math.round(span / DAY_MS)} days`
}
