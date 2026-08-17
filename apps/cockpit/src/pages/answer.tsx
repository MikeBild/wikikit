import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { BookUp } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { CardSkeleton, DataState } from '@/components/data-state'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { I18nText } from '@/components/i18n-text'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RelativeTime } from '@/components/ui/relative-time'
import { Spinner } from '@/components/ui/spinner'
import { liveReadOptions } from '@/lib/live'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { toast } from '@/lib/toast'
import { semanticLabel } from '@/lib/presentation'
import { coverageOf, kindWord, outputLabel } from '@/pages/answers.logic'
import { describeIngest } from '@/pages/sources.logic'

/**
 * One thing this wiki produced, and the one door back into it.
 *
 * The document is read first and acted on second, and that ordering is the
 * whole reason promotion lives here rather than on the list: filing an answer
 * back into the wiki is not a bookmark, it archives the text as a source and
 * runs the ORDINARY ingest pipeline over it — a content hash, a grounding
 * check, a contradiction check, and a change proposal a human has to decide.
 * It creates review work. An operator is owed that sentence before the click,
 * which is what the `Confirm` details say, and they can only weigh it if the
 * text they are about to file is on the same screen.
 *
 * What promotion deliberately does NOT do is publish. The video this loop comes
 * from feeds outputs straight back in; here that would be a wiki whose own
 * answers become the evidence for its next answers, with no human in the
 * circle. So the source is marked `derived_from_output_id`, the lint rule
 * `self-derived-only` reports knowledge that rests on nothing else, and the
 * change still waits for somebody.
 */

/** Derived from the facade, so a field the server stops sending stops compiling. */
type Output = Awaited<ReturnType<typeof wk.outputs.get>>

export function AnswerPage() {
  const space = useSpace()
  // `strict: false` for the same reason the other detail pages use it: no route
  // in router.tsx declares a params schema, so the id arrives optional and is
  // checked rather than asserted.
  const { id } = useParams({ strict: false }) as { id?: string }

  const output = useQuery({
    queryKey: keys.output(id ?? ''),
    queryFn: () => wk.outputs.get(id as string),
    enabled: Boolean(id),
  })

  const title = output.data ? outputLabel(output.data, 'Output') : 'Output'

  return (
    <Page title={title} description="What this wiki produced, the pages it quoted, and the way back into the wiki.">
      {!id ? (
        <EmptyState
          title="No answer named"
          description="This address is missing the id of an answer. Open one from the Answers list."
          data-testid="answer-missing-id"
        />
      ) : (
        <DataState testId="answer-document" query={output} skeleton={<CardSkeleton cards={2} />}>
          {(data) => <OutputDocument output={data} space={space} />}
        </DataState>
      )}
    </Page>
  )
}

function OutputDocument({ output, space }: { output: Output; space: string }) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-center gap-2 text-xs" aria-label="What this is">
        <Badge tone="neutral" data-testid="answer-kind">
          {kindWord(output.kind)}
        </Badge>
        {coverageOf(output) === 'not-covered' ? (
          <Badge tone="unknown" data-testid="answer-uncovered">
            Not covered
          </Badge>
        ) : null}
        <RelativeTime value={output.created_at} data-testid="answer-produced" className="text-muted-foreground" />
      </section>

      {output.question ? (
        <I18nText>
          <section className="flex flex-col gap-1" aria-label="The question">
            <span className="text-muted-foreground text-xs">The question</span>
            <p className="text-sm font-medium" data-testid="answer-question">
              {output.question}
            </p>
          </section>
        </I18nText>
      ) : null}

      <Citations citations={output.citations} />

      <article className="border-border bg-card rounded-lg border p-4">
        {output.markdown.trim() ? (
          /*
            `wk-doc` restores the element styling Tailwind's preflight strips,
            scoped to authored prose so it cannot leak into the console's own
            chrome. No `rehype-raw`: this text came out of a model over
            documents this wiki did not write, so HTML passthrough would make it
            a script surface.
          */
          <div className="wk-doc" data-testid="answer-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{output.markdown}</Markdown>
          </div>
        ) : (
          // Not a blank block: a produced document with no prose in it is a
          // fact about what was produced, and saying so beats an empty card.
          <p className="text-muted-foreground text-sm" data-testid="answer-markdown-empty">
            This document has no text in it.
          </p>
        )}
      </article>

      <Promotion output={output} space={space} />
    </div>
  )
}

/**
 * The pages this document leaned on, as links.
 *
 * An empty list is a measured emptiness and says so rather than disappearing: a
 * briefing quotes no pages by design, and an answer that quotes none is exactly
 * the answer somebody should look at twice before filing it back.
 */
function Citations({ citations }: { citations: Output['citations'] }) {
  return (
    <I18nText>
      <section className="flex flex-col gap-2" aria-labelledby="answer-citations-heading">
        <h2 id="answer-citations-heading" className="text-sm font-semibold">
          Cited pages
        </h2>
        {citations.length === 0 ? (
          <p className="text-muted-foreground text-xs" data-testid="answer-citations-none">
            This document quotes no page of this wiki.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2" data-testid="answer-citations">
            {citations.map((citation, index) => (
              <Link
                key={citation.slug}
                to="/pages/$slug"
                params={{ slug: citation.slug }}
                search={(prev) => prev}
                data-testid={`answer-citation-${index + 1}`}
                className="text-sm underline underline-offset-4"
              >
                {semanticLabel([citation.title, citation.slug], 'Page')}
              </Link>
            ))}
          </div>
        )}
      </section>
    </I18nText>
  )
}

/**
 * Filing this document back into the wiki, and what came of it.
 *
 * Two worlds, and the panel is the same shape in both so a reader who promoted
 * something yesterday finds the outcome where the button was. Unpromoted: one
 * button behind a `Confirm` that says what it costs. Promoted: the ingest job,
 * followed live, and the change it produced — because "it worked" is not the
 * useful sentence here, "here is the change waiting for you" is.
 */
function Promotion({ output, space }: { output: Output; space: string }) {
  const can = useCan()
  const client = useQueryClient()
  const mayPropose = can('knowledge:propose')

  const promote = useMutation({
    mutationFn: () => wk.outputs.promote(output.id),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Filed back — a change is waiting for review' })
      // The whole space subtree by prefix, plus this row: promotion adds an
      // ingest job and (usually) a change proposal, and both are read on pages
      // registered under keys with a query slot that `keys.space` is a prefix
      // of. The output itself is keyed by id and outside that subtree.
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.output(output.id) }),
        client.invalidateQueries({ queryKey: keys.space(space) }),
      ])
    },
    // No `onError` toast: this runs inside `Confirm`, which holds the dialog
    // open and renders the server's own refusal with its next_best_actions.
    // Both refusals worth having are terminal in a way a retry cannot fix — the
    // text is already archived under another source (409), or the queue is at
    // its ceiling (429) — and reporting them twice, once in a box that
    // auto-dismisses, is how an operator learns to read neither.
  })

  if (output.promoted_ingest_id)
    return <PromotionOutcome ingestId={output.promoted_ingest_id} at={output.promoted_at} />

  return (
    <I18nText>
      <section
        className="border-border flex flex-col gap-3 rounded-lg border p-4"
        aria-labelledby="answer-file-heading"
      >
        <h2 id="answer-file-heading" className="text-sm font-semibold">
          Take this into the wiki
        </h2>
        <p className="text-muted-foreground text-sm">
          The text above is archived as a source and read into pages, exactly like a document dropped in the Inbox.
          Nothing here becomes visible knowledge until somebody approves the change it raises.
        </p>
        <Confirm
          title="File this back into the wiki?"
          description="The text above is archived as a source and read into pages."
          /*
            The exact effect, and the part an operator cannot see from the
            button: this makes REVIEW WORK. A wiki whose answers are filed back
            faster than anybody decides them is the production failure this
            whole loop was built around — hundreds of proposals, the oldest
            weeks old, nothing on screen saying so.
          */
          details={
            <div className="flex flex-col gap-2">
              <p>
                <strong>This creates a change somebody has to decide.</strong> The document is archived verbatim, quoted
                claim by claim into pages, and staged as one change proposal — the same path a document dropped in the
                Inbox takes.
              </p>
              <p>
                The source it archives is marked as coming from this wiki's own answer, so knowledge that ends up
                resting only on answers is reported on the Care page rather than passing as evidence from outside.
              </p>
              <p>
                Filing the same text twice archives nothing twice: the second attempt is refused with the source that
                already holds it.
              </p>
            </div>
          }
          confirmLabel="File it back"
          ids={{
            dialog: 'answer-promote-dialog',
            accept: 'answer-promote-confirm',
            cancel: 'answer-promote-cancel',
            error: 'answer-promote-error',
          }}
          onConfirm={() => promote.mutateAsync()}
        >
          {(open) => (
            <DisabledReason
              reason={mayPropose ? null : 'Needs knowledge:propose — filing this back raises a change for review.'}
              data-testid="answer-promote-reason"
            >
              <Button
                className="w-fit"
                data-testid="answer-promote"
                disabled={!mayPropose || promote.isPending}
                onClick={open}
              >
                {/* The label does not rewrite itself while it works
                  (CUI-ACT-5): the spinner and the disabled state carry that. */}
                {promote.isPending ? <Spinner data-icon="inline-start" /> : <BookUp data-icon="inline-start" />}
                File it back
              </Button>
            </DisabledReason>
          )}
        </Confirm>
      </section>
    </I18nText>
  )
}

/**
 * Where a promotion LANDED.
 *
 * The ingest job is polled rather than assumed, because the answer to "what did
 * that do" only exists once the pipeline has run: a job that finishes with a
 * proposal is review work, a job that finishes without one archived text this
 * wiki already held, and both are ordinary. `describeIngest` is the same
 * function the Inbox and the source panel ask, so the three surfaces cannot
 * drift into three readings of one status.
 */
function PromotionOutcome({ ingestId, at }: { ingestId: string; at: string | null }) {
  const job = useQuery({
    queryKey: keys.ingestJob(ingestId),
    queryFn: () => wk.ingest.job(ingestId),
    ...liveReadOptions<Awaited<ReturnType<typeof wk.ingest.job>>>((data) => [data.status]),
  })

  return (
    <I18nText>
      <section
        className="border-border flex flex-col gap-3 rounded-lg border p-4"
        aria-labelledby="answer-filed-heading"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="answer-filed-heading" className="text-sm font-semibold">
            Filed back into the wiki
          </h2>
          <RelativeTime value={at} data-testid="answer-filed-at" className="text-muted-foreground text-xs" />
        </div>
        <DataState
          testId="answer-filed"
          query={job}
          skeleton={
            <div className="bg-muted h-10 w-full animate-pulse rounded" aria-busy="true" aria-label="Loading" />
          }
        >
          {(data) => {
            const report = describeIngest(data)
            return (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium" data-testid="answer-filed-headline">
                  {report.headline}
                </span>
                <span className="text-muted-foreground text-xs">{report.detail}</span>
                {data.proposal_id ? (
                  <Link
                    to="/decisions/proposals/$id"
                    params={{ id: data.proposal_id }}
                    search={(prev) => prev}
                    data-testid="answer-filed-change"
                    className="text-sm underline-offset-4 hover:underline"
                  >
                    Review the change
                  </Link>
                ) : null}
              </div>
            )
          }}
        </DataState>
      </section>
    </I18nText>
  )
}
