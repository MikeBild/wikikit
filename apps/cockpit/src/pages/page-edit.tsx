import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker, useNavigate, useParams } from '@tanstack/react-router'
import { Send } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { DataState } from '@/components/data-state'
import { DisabledReason } from '@/components/disabled-reason'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, type TabDefinition } from '@/components/ui/tabs'
import { canonicalMarkdown, isDirty } from '@/lib/dirty'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  EMPTY_DRAFT,
  conceptProposalBody,
  currentRevisionId,
  draftProblem,
  proposalTitle,
  slugify,
  type PageDraft,
} from '@/pages/page.logic'

/**
 * The editor — one component for `/pages/new` and `/pages/$slug/edit`, because
 * the two differ by exactly one fact: whether a slug is in the address.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS SCREEN DOES NOT SAVE ANYTHING. IT PROPOSES.                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Nothing a human writes becomes visible knowledge directly. Pressing the button
 * stages a CHANGE PROPOSAL and sends the author to it, so the next thing they
 * see is the thing they actually made — an item in somebody's review queue, not
 * a page that appears to be published. That is why the button says "Submit
 * change" and why the confirmation restates it: an editor that said "Save" would
 * be lying about the product's central promise, and the operator would find out
 * when the page they "saved" was not there.
 *
 * The other decision worth naming is the draft guard. A markdown draft lives
 * only in this component; a stray click on a sidebar link takes it with it. So
 * a dirty editor blocks navigation and the browser's own unload, and "dirty" is
 * a comparison against the loaded text (`lib/dirty.ts`) rather than a touched
 * flag — typing a character and deleting it again leaves nothing to warn about,
 * and a warning that fires when there is nothing to lose is one nobody reads the
 * third time.
 */

/** `?space=` is the address of the wiki; a link that drops it changes the subject. */
const KEEP_SEARCH = (previous: { space?: string }) => previous

type Pane = 'write' | 'preview'

const PANES: readonly TabDefinition<Pane>[] = [
  { id: 'write', label: 'Write' },
  { id: 'preview', label: 'Preview' },
]

/**
 * Trailing whitespace and a final newline are differences a textarea
 * manufactures and a reader cannot see. Warning about them — or staging a change
 * over them — would be treating work nobody did as an edit.
 */
function canonicalDraft(draft: PageDraft): unknown {
  return {
    slug: draft.slug,
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    markdown: canonicalMarkdown(draft.markdown),
  }
}

export function PageEditPage() {
  const space = useSpace()
  const can = useCan()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // `strict: false` because no route declares a params schema. The absence of a
  // slug IS the new-page case — the two routes share this component.
  const params = useParams({ strict: false })
  const slug = typeof params.slug === 'string' ? params.slug : null
  const isNew = slug === null

  const concept = useQuery({
    queryKey: keys.concept(space, slug ?? ''),
    queryFn: () => wk.concepts.get(space, slug ?? ''),
    enabled: !isNew,
  })

  /**
   * The history is read for ONE field: the id of the revision this edit is
   * written against.
   *
   * `/v1/spaces/{space}/concepts/{slug}` carries `rev` but not the revision's
   * id, and the id is the stale-base anchor. Without it the server falls back to
   * whatever the current pointer is at STAGING time, so a change approved while
   * this editor was open would be silently overwritten instead of showing the
   * reviewer a stale base. An editor left open for ten minutes is exactly the
   * window that fallback was not written for.
   */
  const history = useQuery({
    queryKey: keys.conceptHistory(space, slug ?? ''),
    queryFn: () => wk.concepts.history(space, slug ?? ''),
    enabled: !isNew,
  })

  const loaded = concept.data
  const baseline: PageDraft = useMemo(() => {
    if (isNew || !loaded) return EMPTY_DRAFT
    return { slug: loaded.slug, title: loaded.title, summary: loaded.summary, markdown: loaded.markdown }
  }, [isNew, loaded])

  // The draft is DERIVED from the baseline until somebody types, rather than
  // copied into state by an effect: an effect that seeds state from a query
  // renders twice on arrival and has to be taught not to clobber typing.
  const [edited, setEdited] = useState<PageDraft | null>(null)
  const [slugTouched, setSlugTouched] = useState(false)
  const [pane, setPane] = useState<Pane>('write')
  const draft = edited ?? baseline
  const dirty = edited !== null && isDirty(draft, baseline, canonicalDraft)

  function update(patch: Partial<PageDraft>) {
    setEdited({ ...draft, ...patch })
  }

  /* ------------------------------------------------------------ the guard */

  // Refs rather than dependencies: the blocker is registered in an effect whose
  // deps include the callbacks, so a fresh closure per keystroke would tear the
  // blocker down and rebuild it on every character typed. Reading the latest
  // value at CALL time is what keeps the callbacks stable.
  const dirtyRef = useRef(false)
  const leavingRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  const shouldBlock = useCallback(() => dirtyRef.current && !leavingRef.current, [])
  const guard = useBlocker({ shouldBlockFn: shouldBlock, enableBeforeUnload: shouldBlock, withResolver: true })

  /* ----------------------------------------------------------- the submit */

  const known = currentRevisionId(history.data?.revisions ?? [])
  const submit = useMutation({
    mutationFn: () =>
      wk.changes.propose(
        space,
        conceptProposalBody({
          space,
          draft,
          isNew,
          // `null` for a new page says "written against no revision". For an
          // edit, an id we could not establish is passed as `undefined`, which
          // omits the field and lets the server fall back — worse than the
          // anchor, better than pinning a base we are guessing at.
          baseRevisionId: isNew ? null : (known ?? undefined),
        }),
      ),
    onSuccess: (result) => {
      // The draft is no longer at risk, and the guard must know that before the
      // navigation below asks it.
      leavingRef.current = true
      // Staging a change adds a row to the review queue and changes nothing
      // about approved knowledge. The space prefix is the one key that covers
      // every list which could be showing it.
      void queryClient.invalidateQueries({ queryKey: keys.space(space) })
      toast({
        tone: 'success',
        title: 'Change submitted for review',
        detail:
          'Nothing is published yet — a reviewer with knowledge:approve decides whether it becomes part of the wiki.',
      })
      void navigate({ to: '/changes/$id', params: { id: result.proposal_id }, search: KEEP_SEARCH })
    },
  })

  const canPropose = can('knowledge:propose')
  /**
   * Why the button will not go, in the order the reader would ask.
   *
   * The scope first, because no amount of typing fixes it. Then "nothing has
   * changed", because on an edit whose page is still loading every field is
   * empty and "a page needs a title" would be the console blaming the author for
   * a read in flight. The draft's own problems last, where they are the only
   * thing left standing between the author and the queue.
   */
  const blockedReason = !canPropose
    ? 'Needs knowledge:propose — submitting a change is what editing a page does here.'
    : !dirty
      ? isNew
        ? 'Nothing written yet.'
        : 'Nothing has changed yet.'
      : draftProblem(draft, isNew)

  /* ------------------------------------------------------------- the form */

  const form = (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="page-title">Title</Label>
          <Input
            id="page-title"
            data-testid="page-edit-title"
            value={draft.title}
            placeholder="What this page is about"
            onChange={(event) => {
              const title = event.target.value
              // The slug follows the title until somebody takes it over. A slug
              // that kept re-deriving after being edited by hand would silently
              // undo a deliberate address.
              update(isNew && !slugTouched ? { title, slug: slugify(title) } : { title })
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="page-slug">Address</Label>
          {isNew ? (
            <>
              <Input
                id="page-slug"
                data-testid="page-edit-slug"
                value={draft.slug}
                spellCheck={false}
                className="font-mono"
                placeholder="every-link-uses-this"
                onChange={(event) => {
                  setSlugTouched(true)
                  update({ slug: event.target.value })
                }}
              />
              <p className="text-muted-foreground text-xs">
                Lower-case letters, digits and hyphens. Every link to this page will use it, so it does not change
                later.
              </p>
            </>
          ) : (
            <>
              <p id="page-slug" data-testid="page-edit-slug" className="font-mono text-sm">
                {draft.slug}
              </p>
              {/* A slug is not editable here, and that is the API being honest
                  rather than a field somebody forgot: staging a different slug
                  would create a SECOND page, not rename this one. */}
              <p className="text-muted-foreground text-xs">
                A page keeps its address. Staging a different one would create a second page rather than rename this.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="page-summary">Summary</Label>
        <Input
          id="page-summary"
          data-testid="page-edit-summary"
          value={draft.summary}
          placeholder="One sentence, shown in the page list and in search results"
          onChange={(event) => update({ summary: event.target.value })}
        />
      </div>

      {/* Below `md` the two panes are one pane with a tab strip; above it they
          sit side by side, because the whole point of a preview is watching the
          document take shape while typing, and a preview a keystroke away is a
          preview nobody opens. */}
      <Tabs tabs={PANES} value={pane} onValueChange={setPane} className="md:hidden" data-testid="page-edit-panes" />

      <div className="grid gap-4 md:grid-cols-2">
        <section className={cn('flex min-w-0 flex-col gap-1.5', pane === 'preview' && 'hidden md:flex')}>
          <Label htmlFor="page-markdown">Markdown</Label>
          <Textarea
            id="page-markdown"
            data-testid="page-edit-markdown"
            value={draft.markdown}
            spellCheck={false}
            rows={20}
            className="min-h-80 font-mono text-xs"
            placeholder={'# Heading\n\nWhat this wiki knows, in Markdown.'}
            onChange={(event) => update({ markdown: event.target.value })}
          />
          {/* Said once, where it changes what somebody writes: prose is what
              this box makes. Claims — the statements that carry a verbatim
              quote — come from ingesting a source, and a textarea cannot
              produce a quote from an archive. */}
          <p className="text-muted-foreground text-xs">
            Claims and the quotes behind them come from ingesting sources under Sources. A page written here stages its
            text and nothing else.
          </p>
        </section>

        <section className={cn('flex min-w-0 flex-col gap-1.5', pane === 'write' && 'hidden md:flex')}>
          <Label>Preview</Label>
          <div className="border-border min-h-80 rounded-lg border p-3">
            {draft.markdown.trim() ? (
              <article className="wk-doc" data-testid="page-edit-preview">
                <Markdown remarkPlugins={[remarkGfm]}>{draft.markdown}</Markdown>
              </article>
            ) : (
              <p data-testid="page-edit-preview" className="text-muted-foreground text-sm">
                The rendered page appears here as you type.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  )

  return (
    <Page
      title={isNew ? 'New page' : `Edit ${baseline.title || (slug ?? '')}`}
      description="Write the page in Markdown. Submitting stages a change — a reviewer decides whether it becomes part of the wiki."
    >
      <div className="flex flex-col gap-5">
        {isNew ? (
          form
        ) : (
          <DataState query={concept} skeleton={<FormSkeleton />}>
            {() => form}
          </DataState>
        )}

        {/* The footer stays on screen while the document scrolls under it: the
            state of the draft and the way out of it are the two things an
            author needs at every scroll position, and a submit button at the
            bottom of a 400-line markdown file is a button nobody finds. */}
        <div className="border-border bg-background/95 sticky bottom-0 -mx-6 flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3 backdrop-blur">
          <p data-testid="page-edit-state" className="text-muted-foreground text-xs">
            {dirty
              ? 'This draft is in this browser only until it is submitted.'
              : isNew
                ? 'Nothing written yet.'
                : 'No changes to submit.'}
          </p>

          <div className="flex flex-wrap gap-2">
            <Confirm
              title="Discard this draft?"
              description="The text goes back to what the wiki holds now."
              details={
                isNew
                  ? 'Everything typed on this page is removed. Nothing has been sent to WikiKit, so there is nothing to undo it with.'
                  : `The editor returns to revision ${concept.data?.rev ?? '—'} of ${draft.slug}, exactly as it stands in the wiki. Your edits are not recoverable.`
              }
              confirmLabel="Discard"
              destructive
              ids={{ dialog: 'page-edit-discard-dialog', accept: 'page-edit-discard-accept' }}
              onConfirm={() => {
                setEdited(null)
                setSlugTouched(false)
              }}
            >
              {(open) => (
                <Button variant="outline" data-testid="page-edit-discard" disabled={!dirty} onClick={open}>
                  Discard draft
                </Button>
              )}
            </Confirm>

            <Confirm
              title="Submit this change?"
              description="This does not publish anything."
              details={
                <div className="flex flex-col gap-2">
                  <p>
                    A change proposal is staged under the title “{proposalTitle(draft, isNew)}”. It becomes part of the
                    wiki only when a reviewer holding knowledge:approve approves it.
                  </p>
                  <p className="text-muted-foreground">
                    {isNew
                      ? `Approving it creates the page /${draft.slug}.`
                      : `Approving it writes revision ${(concept.data?.rev ?? 0) + 1} of ${draft.slug}.`}
                  </p>
                </div>
              }
              confirmLabel="Submit change"
              ids={{ dialog: 'page-edit-submit-dialog', accept: 'page-edit-submit-accept' }}
              onConfirm={() => submit.mutateAsync()}
            >
              {(open) => (
                <DisabledReason reason={blockedReason}>
                  <Button
                    variant="accent"
                    data-testid="page-edit-submit"
                    disabled={blockedReason !== null}
                    onClick={open}
                  >
                    <Send data-icon="inline-start" />
                    Submit change
                  </Button>
                </DisabledReason>
              )}
            </Confirm>
          </div>
        </div>
      </div>

      {/*
        The draft guard. It is an AlertDialog rather than a `Confirm` because
        nothing is being mutated: the question is whose turn it is to decide
        where the browser goes, and the answer has to be given before the
        navigation the router is already holding.
      */}
      <AlertDialog
        open={guard.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open) guard.reset?.()
        }}
      >
        <AlertDialogContent data-testid="page-edit-guard">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without submitting?</AlertDialogTitle>
            <AlertDialogDescription>
              This draft exists only in this browser. Leaving now throws it away — nothing has been sent to WikiKit yet,
              so there is no change to come back to.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="page-edit-guard-stay" onClick={() => guard.reset?.()}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="page-edit-guard-leave"
              onClick={() => guard.proceed?.()}
            >
              Leave and lose it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}

/** The form's shape while the page it edits is being read — never a spinner. */
function FormSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading">
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
      <Skeleton className="h-8 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="hidden h-80 w-full md:block" />
      </div>
    </div>
  )
}
