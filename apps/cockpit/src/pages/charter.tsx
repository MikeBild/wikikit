import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, ScrollText, Trash2 } from 'lucide-react'
import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { DataState } from '@/components/data-state'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import { RelativeTime } from '@/components/ui/relative-time'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useTableView } from '@/hooks/use-table-view'
import { firstPage, type CursorPage } from '@/lib/cursor'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { compareNumber, compareText, compareTime } from '@/lib/table-view'
import { toast } from '@/lib/toast'
import { STATUS_STATE, type DomainState } from '@/lib/tokens'

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE ONE EDIT IN THIS CONSOLE THAT IS NOT A PROPOSAL.                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Everywhere else in WikiKit, writing is proposing: a human types, a change
 * proposal is staged, and nothing is visible knowledge until somebody approves
 * it. The charter is the deliberate exception, and it is an exception because of
 * what it is — human-owned CONFIGURATION rather than synthesized knowledge. It
 * steers classification and synthesis; a charter that had to be reviewed before
 * it could steer anything would mean the rules of the wiki were themselves
 * subject to the machinery those rules govern.
 *
 * That makes this page a document EDITOR, not a proposal form, and it makes one
 * sentence load-bearing: an operator arriving here carries the habit every other
 * page taught them, which is that Submit means "ask somebody". Here it does not.
 * So the immediacy is said out loud in the confirmation rather than discovered
 * afterwards — see the `details` on the save `Confirm`, which is the whole reason
 * this write is behind one at all. It is not destructive; it is *unreviewed*, and
 * that is the fact the operator is owed before the click, not after.
 *
 * What is edited is the AUTHORED half. `GET /charter` answers three text fields
 * and they are not interchangeable:
 *
 *   markdown  — what a human wrote. This is what the textarea holds.
 *   overview  — counts + a concept index, DERIVED from current knowledge.
 *   document  — the two of them concatenated, with marker comments between.
 *
 * The overview is a projection and is rendered here as one, read-only. Writing
 * the full `document` back is a real API capability — the server diffs the
 * overview block and routes a human edit of it through the review gate as an
 * ingest — but it is a capability for a round-tripping agent, not a control this
 * page should offer: a textarea containing both halves invites editing a derived
 * table whose edit then quietly becomes a change proposal in a queue the operator
 * was not looking at. So the editor submits markerless authored text, which
 * `parseCharterDocument` takes wholesale, and the overview cannot be touched from
 * here at all.
 */

/**
 * `CHARTER_MAX_CHARS` in src/domain/charter.ts. Restated rather than imported —
 * the console compiles for a browser and does not reach into the server's
 * modules — and it is checked here so the operator learns the limit while they
 * are still typing, instead of losing the click to a 400 that arrives after it.
 * The server's check remains the real one; this is the courtesy copy.
 */
const CHARTER_MAX_CHARS = 8000

type CharterVersion = NonNullable<Awaited<ReturnType<typeof wk.charter.versions>>['items'][number]>

/**
 * The five domain states, as badge tones.
 *
 * `STATE_TOKEN` in @/lib/tokens maps them onto CSS token NAMES, which is what an
 * SVG stroke needs; `Badge` wants its own `tone` vocabulary. One table here
 * rather than a conditional at the call site, so `superseded` cannot end up
 * reading as a failure on one page and as neutral on the next.
 */
const TONE: Record<DomainState, NonNullable<BadgeProps['tone']>> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
}

/**
 * Module scope, because `useTableView` re-derives the whole view when this array
 * changes identity — and nothing in these cells closes over anything the page
 * holds, so there is nothing to close over.
 */
const VERSION_COLUMNS: readonly DataColumn<CharterVersion>[] = [
  {
    id: 'rev',
    label: 'Revision',
    required: true,
    compare: (left, right) => compareNumber(left.rev, right.rev),
    descFirst: true,
    cell: (version) => <span className="font-mono text-xs">#{version.rev}</span>,
  },
  {
    id: 'status',
    label: 'Status',
    compare: (left, right) => compareText(left.status, right.status),
    // The word as well as the colour: a status that is only a hue is a status a
    // colour-blind reader does not have (CUI-A11Y-5).
    cell: (version) => <Badge tone={TONE[STATUS_STATE[version.status] ?? 'unknown']}>{version.status}</Badge>,
  },
  {
    id: 'author',
    label: 'Written by',
    compare: (left, right) => compareText(left.created_by, right.created_by),
    // Nobody recorded is an em dash, not an empty cell and not "system"
    // (CUI-SEV-2) — a revision whose author the server did not send is a
    // different fact from one written by an account called nothing.
    cell: (version) =>
      version.created_by ? (
        <span className="truncate">{version.created_by}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'written',
    label: 'Written',
    compare: (left, right) => compareTime(left.created_at, right.created_at),
    descFirst: true,
    cell: (version) => <RelativeTime value={version.created_at} data-testid={`charter-version-${version.rev}-time`} />,
  },
]

export function CharterPage() {
  const space = useSpace()
  const can = useCan()
  const client = useQueryClient()
  const admin = can('admin')

  /**
   * `null` is reading, a string is editing — one state rather than an `editing`
   * flag beside a `draft`, because the pair can disagree and this cannot. The
   * draft is deliberately NOT seeded from the query on every render: an operator
   * mid-sentence when a background refetch lands must not have their text
   * replaced by the server's copy of it.
   */
  const [draft, setDraft] = useState<string | null>(null)
  const [versionPage, setVersionPage] = useState<CursorPage>(firstPage)
  const { view, setView } = useTableView('charter-versions', VERSION_COLUMNS)

  const charter = useQuery({ queryKey: keys.charter(space), queryFn: () => wk.charter.get(space) })
  const versions = useQuery({ queryKey: keys.charterVersions(space), queryFn: () => wk.charter.versions(space) })

  /**
   * Both reads move together, and both must: a write mints a revision (the
   * history) and changes the current text (the document). Invalidating one of
   * the two leaves a page whose halves disagree about what was just saved.
   */
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.charter(space) }),
      client.invalidateQueries({ queryKey: keys.charterVersions(space) }),
    ])
  }

  const save = useMutation({
    mutationFn: (markdown: string) => wk.charter.put(space, { markdown }),
    onSuccess: async () => {
      setDraft(null)
      toast({ tone: 'success', title: `Charter written for ${space}` })
      await refresh()
    },
    // No `onError` toast: this runs inside `Confirm`, which keeps the dialog
    // open and renders the server's own refusal with its next_best_actions. A
    // toast as well would report the same failure twice, in two places, one of
    // which auto-dismisses.
  })

  const remove = useMutation({
    mutationFn: () => wk.charter.remove(space),
    onSuccess: async () => {
      setDraft(null)
      toast({ tone: 'info', title: `Charter deleted — ${space} has none until one is written` })
      await refresh()
    },
  })

  const doc = charter.data
  const editing = draft !== null
  const written = doc !== undefined && doc.rev !== null
  const overLimit = draft !== null && draft.length > CHARTER_MAX_CHARS
  const unchanged = draft !== null && doc !== undefined && draft === doc.markdown

  const submitReason = overLimit
    ? `A charter may be at most ${CHARTER_MAX_CHARS.toLocaleString()} characters — the server refuses a longer one.`
    : unchanged
      ? 'Nothing has changed.'
      : null

  return (
    <Page
      title="Charter"
      description="The governing document for this wiki: what it is for, what belongs in it, and how synthesis should read it."
      actions={
        doc === undefined ? null : editing ? (
          <>
            <Button
              variant="ghost"
              data-testid="charter-cancel"
              disabled={save.isPending}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Confirm
              title="Write the charter"
              description={`Replace the charter of ${space} with the text you have written.`}
              /*
                The exact effect, and the part that is unlike everything else in
                this console. An operator who has spent the day submitting
                changes for review has every reason to expect this to queue —
                and it does not. Saying it here is the difference between a
                surprise and a decision.
              */
              details={
                <div className="flex flex-col gap-2">
                  <p>
                    <strong>This takes effect immediately.</strong> The charter is not reviewed: it is configuration an
                    admin owns, so no change proposal is created and nobody approves it.
                  </p>
                  <p>
                    Revision {(doc.rev ?? 0) + 1} becomes current the moment you confirm, and revision {doc.rev ?? '—'}{' '}
                    is superseded — kept in history, no longer in force. Classification and synthesis in{' '}
                    <span className="font-mono">{space}</span> read the new text from their next job onwards; pages
                    already written are not revisited.
                  </p>
                </div>
              }
              confirmLabel="Write charter"
              ids={{
                dialog: 'charter-save-dialog',
                accept: 'charter-save-confirm',
                cancel: 'charter-save-cancel',
                error: 'charter-save-error',
              }}
              onConfirm={() => save.mutateAsync(draft)}
            >
              {(open) => (
                <DisabledReason reason={submitReason} data-testid="charter-submit-reason">
                  <Button
                    variant="accent"
                    data-testid="charter-submit"
                    disabled={save.isPending || overLimit || unchanged}
                    onClick={open}
                  >
                    Write charter
                  </Button>
                </DisabledReason>
              )}
            </Confirm>
          </>
        ) : (
          <>
            {written ? (
              <Confirm
                title="Delete the charter"
                description={`Remove the charter of ${space}.`}
                details={
                  <div className="flex flex-col gap-2">
                    <p>
                      Revision {doc.rev} is superseded and <span className="font-mono">{space}</span> is left with no
                      charter. Every revision stays readable in the history below — this deletes what is in force, not
                      the record of it.
                    </p>
                    <p>
                      Until a new charter is written, nothing steers classification and synthesis for this wiki: they
                      fall back to their defaults. Pages already written are unaffected.
                    </p>
                  </div>
                }
                confirmLabel="Delete charter"
                destructive
                ids={{
                  dialog: 'charter-delete-dialog',
                  accept: 'charter-delete-confirm',
                  cancel: 'charter-delete-cancel',
                  error: 'charter-delete-error',
                }}
                onConfirm={() => remove.mutateAsync()}
              >
                {(open) => (
                  <DisabledReason
                    reason={admin ? null : 'Needs admin — the charter is configuration, not reviewed knowledge.'}
                    data-testid="charter-delete-reason"
                  >
                    <Button
                      variant="destructive"
                      data-testid="charter-delete"
                      disabled={!admin || remove.isPending}
                      onClick={open}
                    >
                      <Trash2 data-icon="inline-start" />
                      Delete
                    </Button>
                  </DisabledReason>
                )}
              </Confirm>
            ) : null}
            <DisabledReason
              reason={admin ? null : 'Needs admin — the charter is configuration, not reviewed knowledge.'}
              data-testid="charter-edit-reason"
            >
              <Button
                variant="accent"
                data-testid="charter-edit"
                disabled={!admin}
                onClick={() => setDraft(doc.markdown)}
              >
                <Pencil data-icon="inline-start" />
                Edit
              </Button>
            </DisabledReason>
          </>
        )
      }
    >
      <div className="flex flex-col gap-6">
        <DataState query={charter} skeleton={<DocumentSkeleton />}>
          {(data) =>
            draft === null ? (
              <ReadingView
                markdown={data.markdown}
                rev={data.rev}
                updatedAt={data.updated_at}
                overview={data.overview}
                canWrite={admin}
                onWrite={() => setDraft(data.markdown)}
              />
            ) : (
              <EditingView draft={draft} onChange={setDraft} overLimit={overLimit} busy={save.isPending} />
            )
          }
        </DataState>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold tracking-tight">Version history</h2>
            <p className="text-muted-foreground text-sm">
              Every charter written for this wiki, newest first. Writing supersedes the current revision rather than
              overwriting it.
            </p>
          </div>
          <DataTable
            testId="charter-versions"
            columns={VERSION_COLUMNS}
            rows={versions.data?.items ?? []}
            rowKey={(version) => String(version.rev)}
            rowTestId={(version) => `charter-version-${version.rev}`}
            query={versions}
            view={view}
            onViewChange={setView}
            page={versionPage}
            onPageChange={setVersionPage}
            unit="revisions"
            empty="No charter has ever been written for this wiki."
          />
        </section>
      </div>
    </Page>
  )
}

/** The document, as a document. */
function ReadingView({
  markdown,
  rev,
  updatedAt,
  overview,
  canWrite,
  onWrite,
}: {
  markdown: string
  rev: number | null
  updatedAt: string | null
  overview: { concepts: number; decisions: number; sources: number }
  canWrite: boolean
  onWrite: () => void
}) {
  const empty = rev === null || markdown.trim().length === 0

  return (
    <div className="flex flex-col gap-4">
      {empty ? (
        /*
          Empty is its own world and must not read as a failure (CUI-LOAD-4).
          A wiki with no charter is a perfectly ordinary wiki — it just has
          nothing steering synthesis — so the description says what a charter
          would do and the action is the way out of the state.
        */
        <EmptyState
          icon={ScrollText}
          title="No charter yet"
          description="A charter tells WikiKit what this wiki is for, what belongs in it and what does not, and how a page should be written. It is read by classification and synthesis on every job — without one, they fall back to their defaults."
          action={
            <DisabledReason
              reason={canWrite ? null : 'Needs admin — the charter is configuration, not reviewed knowledge.'}
              data-testid="charter-write-reason"
            >
              <Button variant="accent" data-testid="charter-write" disabled={!canWrite} onClick={onWrite}>
                Write the charter
              </Button>
            </DisabledReason>
          }
          data-testid="charter-empty"
        />
      ) : (
        <article className="border-border bg-card rounded-lg border p-4">
          <div className="text-muted-foreground mb-3 flex flex-wrap items-center gap-2 text-xs">
            <Badge tone="success" data-testid="charter-rev">
              Revision {rev}
            </Badge>
            <span>written</span>
            <RelativeTime value={updatedAt} data-testid="charter-updated" />
          </div>
          {/*
            `wk-doc` restores the element styling Tailwind's preflight strips,
            and it is scoped to authored prose so it cannot leak into the
            console's own chrome. No `rehype-raw`: a charter is text a human
            typed, and HTML passthrough would make it a script surface.
          */}
          <div className="wk-doc" data-testid="charter-document">
            <Markdown remarkPlugins={[remarkGfm]}>{markdown}</Markdown>
          </div>
        </article>
      )}

      <OverviewPanel overview={overview} />
    </div>
  )
}

/**
 * The derived half, shown as derived.
 *
 * These counts are appended to the charter every time an agent reads it, so
 * leaving them off the page would hide part of what the document actually says.
 * They are rendered as a separate, unmistakably read-only strip because they are
 * a projection of current knowledge — nothing an operator types here could
 * change them, and a control implying otherwise would be a lie about the model.
 *
 * A measured zero prints as `0`, not as `—`: "this wiki has no decisions" is a
 * measurement, and the em-dash rule (CUI-SEV-2) is for values nobody sent.
 */
function OverviewPanel({ overview }: { overview: { concepts: number; decisions: number; sources: number } }) {
  const stats: { label: string; value: number; id: string }[] = [
    { id: 'concepts', label: 'Pages', value: overview.concepts },
    { id: 'decisions', label: 'Decisions', value: overview.decisions },
    { id: 'sources', label: 'Sources', value: overview.sources },
  ]
  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4" data-testid="charter-overview">
      <div className="flex flex-wrap gap-6">
        {stats.map((stat) => (
          <div key={stat.id} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">{stat.label}</span>
            <span className="text-lg font-semibold tabular-nums" data-testid={`charter-overview-${stat.id}`}>
              {stat.value}
            </span>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Derived from current knowledge and appended to the charter automatically, together with an index of every page
        in this wiki. It is not part of the text above and cannot be edited here.
      </p>
    </section>
  )
}

/**
 * Write on the left, read on the right — and stacked below `lg`, where two
 * columns of prose are two columns of nothing.
 */
function EditingView({
  draft,
  onChange,
  overLimit,
  busy,
}: {
  draft: string
  onChange: (next: string) => void
  overLimit: boolean
  busy: boolean
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="charter-body" className="text-sm font-medium">
            Charter (Markdown)
          </label>
          <span
            data-testid="charter-length"
            className={
              overLimit ? 'text-destructive text-xs tabular-nums' : 'text-muted-foreground text-xs tabular-nums'
            }
          >
            {draft.length.toLocaleString()} / {CHARTER_MAX_CHARS.toLocaleString()}
          </span>
        </div>
        <Textarea
          id="charter-body"
          data-testid="charter-body"
          value={draft}
          disabled={busy}
          aria-invalid={overLimit || undefined}
          aria-describedby="charter-body-help"
          onChange={(event) => onChange(event.target.value)}
          className="min-h-[24rem] font-mono text-xs"
          placeholder="What this wiki is for, what belongs in it, and how a page should be written."
        />
        <p id="charter-body-help" className="text-muted-foreground text-xs">
          Plain Markdown. Every classification and synthesis job for this wiki reads it, so write the rules a
          contributor would need — scope, vocabulary, what is out of bounds.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Preview</span>
        <div className="border-border bg-card min-h-[24rem] rounded-lg border p-4">
          <div className="wk-doc" data-testid="charter-preview">
            <Markdown remarkPlugins={[remarkGfm]}>{draft}</Markdown>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A skeleton in the shape of a document, never the word "Loading…" (CUI-LOAD-1). */
function DocumentSkeleton() {
  return (
    <div
      className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4"
      aria-busy="true"
      aria-label="Loading"
    >
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  )
}
