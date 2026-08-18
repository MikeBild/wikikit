import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { CopyButton } from '@/components/copy-button'
import { SegmentedControl } from '@/components/controls'
import { ContextHelp } from '@/components/context-help'
import { CardSkeleton, DataState } from '@/components/data-state'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RelativeTime } from '@/components/ui/relative-time'
import { useSpace } from '@/lib/space'
import { presentValue } from '@/lib/presentation'
import { defaultSourceView, sourceLabel, type SourceView } from '@/pages/sources.logic'

/**
 * One archived source: the evidence itself.
 *
 * Everything on this page is read-only, and that is a property of the product
 * rather than a missing feature. A source is the anchor a claim's verbatim
 * quote is checked against — an editable source is a knowledge base whose
 * citations can be made true after the fact, which is the one thing WikiKit
 * exists to prevent. So there is no edit control here to gate by scope, and no
 * "correct this" affordance to explain away: a document that turned out to be
 * wrong is superseded by archiving the corrected one, never by rewriting the
 * bytes somebody already quoted.
 */

/** Derived from the facade, so a field the server stops sending stops compiling. */
type Source = Awaited<ReturnType<typeof wk.sources.get>>

const KIND_WORDS: Record<string, string> = {
  markdown: 'Markdown',
  text: 'Text',
  url: 'Web page',
  import: 'Imported',
}

const LANGUAGE_WORDS: Record<string, string> = {
  en: 'English',
  de: 'German',
  simple: 'Unstemmed',
}

export function SourcePage() {
  const space = useSpace()
  // `strict: false` for the same reason `useTableView` uses it: no route in
  // router.tsx declares a params schema, so the id arrives as an optional
  // string and is checked rather than asserted.
  const { id } = useParams({ strict: false }) as { id?: string }

  const source = useQuery({
    queryKey: keys.source(space, id ?? ''),
    queryFn: () => wk.sources.get(space, id as string),
    enabled: Boolean(id),
  })

  const title = source.data ? sourceLabel(source.data) : 'Source'

  return (
    <Page
      title={title}
      description={source.data?.summary ?? "Archived verbatim and read-only — this is what the wiki's claims quote."}
    >
      {!id ? (
        <EmptyState
          title="No source named"
          description="This address is missing the id of a source. Open one from the Sources list."
          data-testid="source-missing-id"
        />
      ) : (
        <DataState testId="source-document" query={source} skeleton={<CardSkeleton cards={2} />}>
          {(data) => <SourceDocument source={data} />}
        </DataState>
      )}
    </Page>
  )
}

function SourceDocument({ source }: { source: Source }) {
  const [view, setView] = useState<SourceView>(() => defaultSourceView(source.kind))

  // Every key the ingest recorded that is not already a named row above. Today
  // that is only `source_kind`, but an imported bundle can carry more, and a
  // metadata bag rendered as nothing is provenance the console quietly ate.
  const extraMetadata = Object.entries(source.metadata).filter(([key]) => key !== 'source_kind')

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>The archive record</CardTitle>
          <CardAction>
            <ContextHelp title="About the archive record" testId="source-archive-help">
              <p>
                What WikiKit knows about these bytes. The hash makes the same document ingested twice one source rather
                than two.
              </p>
            </ContextHelp>
          </CardAction>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind">
              <Badge tone="neutral" data-testid="source-kind">
                {KIND_WORDS[source.kind] ?? source.kind}
              </Badge>
            </Field>
            <Field label="Archived">
              <RelativeTime value={source.created_at} data-testid="source-archived" />
            </Field>
            <Field label="What it is">
              {typeof source.metadata.source_kind === 'string' ? (
                <span data-testid="source-kind-hint">{source.metadata.source_kind}</span>
              ) : (
                // Nobody said, which is not the same fact as "an ordinary
                // document" — the server persists the absence rather than
                // guessing, so the console prints the absence (CUI-SEV-2).
                <span className="text-muted-foreground" data-testid="source-kind-hint">
                  —
                </span>
              )}
            </Field>
            <Field label="Retrieval language">
              <span data-testid="source-language">
                {source.language ? (LANGUAGE_WORDS[source.language] ?? source.language) : "This wiki's language"}
              </span>
            </Field>
            <Field label="Address">
              {source.url ? (
                <a
                  href={source.url}
                  // `noreferrer` as well as `noopener`: this address came from
                  // whoever ingested the document, and the console must not
                  // hand an untrusted site the page it was opened from.
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid="source-url"
                  className="inline-flex items-center gap-1 break-all underline-offset-4 hover:underline"
                >
                  {source.url}
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ) : (
                <span className="text-muted-foreground" data-testid="source-url">
                  —
                </span>
              )}
            </Field>
            <Field label="Content hash">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone="unknown">Source locked</Badge>
                <code className="font-mono text-xs break-all" data-testid="source-hash">
                  {source.content_hash}
                </code>
                <CopyButton value={source.content_hash} size="icon-sm" label="Copy hash" data-testid="copy-hash" />
              </span>
            </Field>
            {extraMetadata.map(([key, value]) => (
              <Field key={key} label={key}>
                <span className="text-xs break-all" data-testid={`source-metadata-${key}`}>
                  {typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                    ? String(presentValue(value))
                    : JSON.stringify(presentValue(value))}
                </span>
              </Field>
            ))}
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            The archived content cannot be changed. A check may update metadata only; corrections arrive as a new
            source.
          </p>
        </CardContent>
      </Card>

      {/* Only for a source a connector pushed. Six empty rows saying "—" on
          every hand-added document would teach the reader to stop looking at
          this card on the one where it is filled in. */}
      {source.stream_id ? (
        <Card>
          <CardHeader>
            <CardTitle>Kept in step by a connector</CardTitle>
            <CardAction>
              <ContextHelp title="About connector-managed sources" testId="source-connector-help">
                <p>
                  A stable upstream id lets each push archive a new version without forking the archive. Older versions
                  remain available to the claims that quote them.
                </p>
              </ContextHelp>
            </CardAction>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label="Version">
                <span data-testid="source-version">{source.source_version ?? '—'}</span>
              </Field>
              <Field label="Seen upstream">
                <RelativeTime value={source.observed_at} data-testid="source-observed" />
              </Field>
              <Field label="Content is as of">
                <RelativeTime value={source.effective_at} data-testid="source-effective" />
              </Field>
              <Field label="Replaces">
                {source.supersedes_source_id ? (
                  <Link
                    to="/sources/$id"
                    params={{ id: source.supersedes_source_id }}
                    data-testid="source-supersedes"
                    className="underline-offset-4 hover:underline"
                  >
                    The version before this one
                  </Link>
                ) : (
                  <span className="text-muted-foreground" data-testid="source-supersedes">
                    Nothing — this is the first version
                  </span>
                )}
              </Field>
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>The document</CardTitle>
          <CardAction>
            <ContextHelp title="About the archived document" testId="source-document-help">
              <p>
                {source.kind === 'url'
                  ? 'The page as fetched and projected to Markdown. The live page may have changed since.'
                  : 'Exactly what was handed to WikiKit. Nothing here has been edited.'}
              </p>
            </ContextHelp>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <SegmentedControl
            label="How to read this document"
            value={view}
            onChange={setView}
            data-testid="source-view"
            options={[
              { id: 'rendered', label: 'Rendered' },
              { id: 'verbatim', label: 'Verbatim' },
            ]}
          />
          {view === 'rendered' ? (
            /*
             * `react-markdown` with `remark-gfm` and NOTHING else. No
             * `rehype-raw`, no HTML passthrough, no plugin that turns a string
             * into an element — a source document is text somebody else wrote,
             * fetched from an address somebody else chose, and this console
             * renders it inside the same session that can approve knowledge and
             * mint API keys. `react-markdown` escapes raw HTML by default; the
             * only way to lose that is to add the plugin that disables it, so
             * the defence here is the absence of a line rather than the presence
             * of one, and this comment is what keeps somebody from adding it.
             */
            <div className="wk-doc overflow-x-auto text-sm" data-testid="source-rendered">
              <Markdown remarkPlugins={[remarkGfm]}>{source.markdown}</Markdown>
            </div>
          ) : (
            <pre
              data-testid="source-verbatim"
              className="bg-muted/40 max-h-[70vh] overflow-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap"
            >
              {source.raw_content}
            </pre>
          )}
        </CardContent>
      </Card>

      {/*
        Said rather than shown, because the API cannot answer it. There is no
        read anywhere in `ROUTES` that lists the claims citing a source — the
        citation edge is walked from the claim's side — so a "cited by" panel
        here could only ever be a guess dressed as a fact. Naming the gap and
        pointing at the surface that can find the quotes is the honest version;
        inventing a count would be the console making up provenance on the page
        whose entire job is provenance.
      */}
      <p className="text-muted-foreground text-sm" data-testid="citations-note">
        WikiKit does not answer which pages cite this source. To find them, search the wiki for a phrase from the
        document — every claim carries its quote.{' '}
        <Link to="/search" data-testid="source-search-link" className="underline underline-offset-4">
          Search this wiki
        </Link>
        .
      </p>
    </div>
  )
}

/** One labelled fact in a definition list. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground text-xs tracking-wide uppercase">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  )
}
