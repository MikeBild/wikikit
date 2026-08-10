import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Plus, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { DataState } from '@/components/data-state'
import { DisabledReason } from '@/components/disabled-reason'
import { I18nText } from '@/components/i18n-text'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTable, type DataColumn } from '@/components/ui/data-table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RelativeTime } from '@/components/ui/relative-time'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useTableView } from '@/hooks/use-table-view'
import { firstPage, type CursorPage } from '@/lib/cursor'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { compareText, compareTime } from '@/lib/table-view'
import { toast } from '@/lib/toast'

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE INSTALLATION'S WIKIS, AND THE SETTINGS THAT DECIDE HOW EACH READS.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * This is the one page in the console that is not about a single wiki, so it is
 * also the one page where `useSpace()` is not the subject: it is used only to
 * mark which row the rest of the console is currently reading, because a list of
 * eight slugs with no "you are here" is a list an operator has to cross-reference
 * against the sidebar.
 *
 * `wk_spaces.settings` is a free-form JSON column and the server validates only
 * the two keys that would break retrieval if they were wrong (`language`,
 * `imports`). That is a server-side decision about extensibility and it is a good
 * one; it is NOT a licence for this page to render a JSON textarea. A settings
 * editor made of raw JSON hands the operator every failure mode the endpoint's
 * validation exists to prevent — a mistyped language that silently reindexes
 * nothing, an `imports` entry that is a string instead of an array, a key nobody
 * reads because it was spelled `purpouse` — and it makes the console a worse
 * client than curl, because curl at least does not pretend to be a form. So each
 * field below is a real control over a key something in WikiKit actually reads,
 * and the keys this page does not model are preserved rather than erased. See
 * `SettingsForm` for how.
 */

type Space = NonNullable<Awaited<ReturnType<typeof wk.spaces.list>>['items'][number]>

/** Mirrors SPACE_LANGUAGES in src/http/schemas.ts — the server rejects anything else. */
const LANGUAGES = [
  { value: 'en', label: 'English', hint: 'English stemming and stop words' },
  { value: 'de', label: 'German', hint: 'German stemming and stop words' },
  { value: 'simple', label: 'Simple', hint: 'No stemming — match words exactly as written' },
] as const

type Language = (typeof LANGUAGES)[number]['value']

/** `SPACE_SLUG` in src/http/schemas.ts. A slug the server would refuse is caught before the click. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * The server's own fallback, restated: `updateSpaceSettingsHandler` reads an
 * absent `settings.language` as `'en'` when it decides whether a reindex is
 * needed. So an unset language is not unknown — it is English, and the row says
 * so while still distinguishing "chosen" from "defaulted".
 */
const DEFAULT_LANGUAGE: Language = 'en'

function readString(settings: Record<string, unknown>, key: string): string {
  const value = settings[key]
  return typeof value === 'string' ? value : ''
}

function readLanguage(settings: Record<string, unknown>): Language | null {
  const value = settings.language
  return LANGUAGES.some((entry) => entry.value === value) ? (value as Language) : null
}

function readImports(settings: Record<string, unknown>): string[] {
  const value = settings.imports
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** `settings.agent_context` — an object, or nothing usable. */
function readAgentContext(settings: Record<string, unknown>): Record<string, unknown> {
  const value = settings.agent_context
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function readKeywords(context: Record<string, unknown>): string[] {
  const value = context.keywords
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** A comma-separated field back into a list, with the empties dropped. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const COLUMNS: readonly DataColumn<Space & { current: boolean }>[] = [
  {
    id: 'wiki',
    label: 'Wiki',
    required: true,
    compare: (left, right) => compareText(left.slug, right.slug),
    cell: (space) => (
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-xs">{space.slug}</span>
          {space.current ? (
            <Badge tone="accent" data-testid={`space-current-${space.slug}`}>
              Reading
            </Badge>
          ) : null}
        </div>
        <span className="text-muted-foreground truncate">{space.name}</span>
      </div>
    ),
  },
  {
    id: 'purpose',
    label: 'Purpose',
    // `TableCell` is `whitespace-nowrap`, which is right for a slug and wrong for
    // a sentence: without the override this column would be one unbreakable line
    // and would set the table's width on its own.
    className: 'max-w-80 whitespace-normal',
    compare: (left, right) => compareText(readString(left.settings, 'purpose'), readString(right.settings, 'purpose')),
    cell: (space) => {
      // `purpose` first, `description` as the fallback: both are read by context
      // selection, and a wiki configured with only one of them should not show a
      // blank column while the server is happily ranking on it.
      const text = readString(space.settings, 'purpose') || readString(space.settings, 'description')
      return text ? <span className="line-clamp-2">{text}</span> : <span className="text-muted-foreground">—</span>
    },
  },
  {
    id: 'language',
    label: 'Retrieval',
    compare: (left, right) =>
      compareText(readLanguage(left.settings) ?? DEFAULT_LANGUAGE, readLanguage(right.settings) ?? DEFAULT_LANGUAGE),
    cell: (space) => {
      const chosen = readLanguage(space.settings)
      // Never colour alone, and never a bare "en" that hides whether anybody
      // decided: the word says which, and "default" says who.
      return chosen ? (
        <span className="font-mono text-xs">{chosen}</span>
      ) : (
        <span className="text-muted-foreground font-mono text-xs">{DEFAULT_LANGUAGE} · default</span>
      )
    },
  },
  {
    id: 'imports',
    label: 'Reads from',
    cell: (space) => {
      const imports = readImports(space.settings)
      // Not configured and configured-as-none are the same fact here — this wiki
      // reads nothing but itself — and neither is a count, so neither is a 0.
      if (imports.length === 0) return <span className="text-muted-foreground">—</span>
      return (
        <div className="flex flex-wrap gap-1">
          {imports.map((slug) => (
            <Badge key={slug} tone="neutral" className="font-mono text-[10px]">
              {slug}
            </Badge>
          ))}
        </div>
      )
    },
  },
  {
    id: 'updated',
    label: 'Changed',
    hiddenByDefault: true,
    descFirst: true,
    compare: (left, right) => compareTime(left.updated_at, right.updated_at),
    cell: (space) => <RelativeTime value={space.updated_at} data-testid={`space-${space.slug}-updated`} />,
  },
  {
    id: 'actions',
    label: 'Actions',
    headerHidden: true,
    required: true,
    className: 'w-px',
    // A component rather than JSX assembled here, so this array can stay at
    // module scope: `useTableView` re-derives the whole view whenever the column
    // array changes identity, and a list rebuilt on every render re-sorts its
    // rows for every keystroke anywhere on the page. The scope check and the
    // dialog state the actions need therefore live inside the row, not above it.
    cell: (space) => <RowActions slug={space.slug} />,
  },
]

export function SpacesPage() {
  const current = useSpace()
  const can = useCan()
  const admin = can('admin')

  const [page, setPage] = useState<CursorPage>(firstPage)
  const [creating, setCreating] = useState(false)
  const { view, setView } = useTableView('spaces', COLUMNS)

  const spaces = useQuery({ queryKey: keys.spaces(), queryFn: () => wk.spaces.list() })

  const rows = (spaces.data?.items ?? []).map((space) => ({ ...space, current: space.slug === current }))

  return (
    <Page
      title="Wikis"
      description="Every wiki this installation holds, what each one is for, and how each one is read."
      actions={
        <DisabledReason reason={admin ? null : 'Needs admin — creating a wiki is an installation-level act.'}>
          <Button variant="accent" data-testid="spaces-new" disabled={!admin} onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" />
            New wiki
          </Button>
        </DisabledReason>
      }
    >
      <div className="flex flex-col gap-6">
        <DataTable
          testId="spaces"
          columns={COLUMNS}
          rows={rows}
          rowKey={(space) => space.id}
          rowTestId={(space) => `space-row-${space.slug}`}
          query={spaces}
          view={view}
          onViewChange={setView}
          page={page}
          onPageChange={setPage}
          unit="wikis"
          empty="This installation holds no wikis yet."
        />

        <ExchangeNote />
      </div>

      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
    </Page>
  )
}

/**
 * What an operator can do to one wiki from the list: take a copy of it, or change
 * how it is read.
 *
 * Export is `knowledge:read` and settings are `admin`, and both are rendered
 * either way — the disabled control plus its reason teaches the operator that the
 * capability exists and what it would take, which a control that is simply absent
 * does not (CUI-ACT / DisabledReason).
 */
function RowActions({ slug }: { slug: string }) {
  const can = useCan()
  const admin = can('admin')
  const [open, setOpen] = useState(false)

  return (
    /*
      `flex-wrap`, because below `md` the table pins this last cell to the right
      edge and caps it at 144px (see components/ui/table.tsx). Two controls in a
      row do not fit that, and a control that overflows a pinned cell is a control
      a phone cannot reach — which on this page means export and settings.
    */
    <div className="flex flex-wrap justify-end gap-1">
      <ExportMenu slug={slug} />
      <DisabledReason
        reason={admin ? null : 'Needs admin — settings decide how this wiki is read.'}
        data-testid={`space-settings-${slug}-reason`}
      >
        <Button
          variant="outline"
          size="sm"
          data-testid={`space-settings-${slug}`}
          disabled={!admin}
          onClick={() => setOpen(true)}
        >
          <Settings2 data-icon="inline-start" />
          Settings
        </Button>
      </DisabledReason>
      {open ? <SettingsDialog slug={slug} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

/**
 * Export is a NAVIGATION, not a mutation: the endpoint answers a zip with a
 * `content-disposition`, so an anchor does exactly the right thing and a fetch
 * would only mean holding the whole bundle in memory to hand it back to the
 * browser. Same-origin, so the session cookie rides along without this page
 * knowing anything about credentials.
 *
 * A link and not a button, because it navigates and changes nothing (CUI-ACT-1).
 */
function ExportMenu({ slug }: { slug: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" data-testid={`space-export-${slug}`}>
          <Download data-icon="inline-start" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <a href={`/v1/spaces/${slug}/export?format=md`} download data-testid={`space-export-${slug}-md`}>
              <div className="flex flex-col gap-0.5">
                <span>Markdown tree</span>
                <span className="text-muted-foreground text-xs">
                  One file per page, decision and source. Readable in any editor.
                </span>
              </div>
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`/v1/spaces/${slug}/export?format=okf`} download data-testid={`space-export-${slug}-okf`}>
              <div className="flex flex-col gap-0.5">
                <span>Open Knowledge Format</span>
                <span className="text-muted-foreground text-xs">
                  The interchange bundle: claims, citations and relations survive the round trip.
                </span>
              </div>
            </a>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * What the two formats are, and where the other direction lives.
 *
 * WHY there is no upload control here: importing is `POST /v1/spaces/{space}/import`
 * with a raw zip as the request body, and `api/wk.ts` — the only way a page in
 * this console reaches the server — exposes no call for it. Pages never touch
 * `api` or `fetch` directly, so an uploader cannot be built from this module at
 * all; it needs the facade to grow a method first. Rather than leave the operator
 * at a dead end, the note says where the capability actually is. Every dead end
 * gets a route forward.
 */
function ExchangeNote() {
  return (
    <I18nText>
      <section
        className="border-border bg-card flex flex-col gap-2 rounded-lg border p-4"
        data-testid="spaces-exchange"
      >
        <h2 className="text-sm font-semibold tracking-tight">Taking a wiki elsewhere</h2>
        <p className="text-muted-foreground text-sm">
          <strong className="text-foreground font-medium">Markdown tree</strong> is a zip of ordinary files — one per
          page, decision and source, plus an index. It is what to hand somebody who just wants to read the knowledge,
          and it is lossy: claims, citations and relations are prose in it, not structure.
        </p>
        <p className="text-muted-foreground text-sm">
          <strong className="text-foreground font-medium">Open Knowledge Format</strong> is the interchange bundle. It
          carries the structure as well as the text, so a wiki exported from one WikiKit and imported into another
          arrives with its claims still quoting their sources.
        </p>
        <p className="text-muted-foreground text-sm">
          Importing a bundle is not done from this console. Sources in an imported bundle are archived directly —
          evidence asserts nothing — but its pages and claims are staged as a single change for review, exactly like
          knowledge WikiKit synthesized itself. Use the API or the CLI, then review the change it raises.
        </p>
      </section>
    </I18nText>
  )
}

/**
 * Creating a wiki, behind a confirmation that says the part nobody expects.
 *
 * WikiKit has no delete-space endpoint — not one this console withholds, one
 * that does not exist — so a slug typed here is permanent and is the address
 * every link into this wiki will carry forever. That is the fact the `details`
 * box exists to state.
 *
 * `purpose` is deliberately NOT collected here even though `wk.spaces.create`'s
 * signature accepts one: the server's `zCreateSpaceRequest` is `{slug, name,
 * settings?}` and zod strips keys it does not know, so a purpose typed into this
 * dialog would be accepted, discarded, and never seen again. A field that
 * silently drops what an operator wrote is worse than no field — so purpose is
 * where it is actually stored, in Settings, one click away.
 */
function CreateDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: () => wk.spaces.create({ slug, name: name.trim() }),
    onSuccess: async () => {
      toast({ tone: 'success', title: `Wiki ${slug} created` })
      onClose()
      await client.invalidateQueries({ queryKey: keys.spaces() })
    },
  })

  const slugValid = SLUG.test(slug)
  const nameValid = name.trim().length > 0 && name.trim().length <= 200
  const reason = !slugValid
    ? 'A slug is lower-case letters, digits and hyphens, starting with a letter or digit.'
    : !nameValid
      ? 'A wiki needs a name, of at most 200 characters.'
      : null

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent data-testid="space-create-dialog" closeDisabled={create.isPending}>
        <DialogHeader>
          <DialogTitle>New wiki</DialogTitle>
          <DialogDescription>
            A wiki is a whole knowledge base: its own pages, sources, changes and charter. Nothing is shared with
            another wiki unless it is declared in Settings.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="space-create-slug">Slug</Label>
            <Input
              id="space-create-slug"
              data-testid="space-create-slug"
              value={slug}
              disabled={create.isPending}
              aria-invalid={slug.length > 0 && !slugValid ? true : undefined}
              aria-describedby="space-create-slug-help"
              onChange={(event) => setSlug(event.target.value)}
              placeholder="platform-runbooks"
              className="font-mono"
            />
            <p id="space-create-slug-help" className="text-muted-foreground text-xs">
              Lower-case letters, digits and hyphens. It is the address of this wiki in every URL and every API call,
              and it cannot be changed afterwards.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="space-create-name">Name</Label>
            <Input
              id="space-create-name"
              data-testid="space-create-name"
              value={name}
              disabled={create.isPending}
              aria-describedby="space-create-name-help"
              onChange={(event) => setName(event.target.value)}
              placeholder="Platform runbooks"
            />
            <p id="space-create-name-help" className="text-muted-foreground text-xs">
              What a person calls it. This one can be changed later.
            </p>
          </div>
        </div>

        <DialogFooter data-testid="space-create-footer">
          <Button variant="outline" data-testid="space-create-cancel" disabled={create.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Confirm
            title="Create this wiki"
            description={`Add ${slug || 'a new wiki'} to this installation.`}
            details={
              <div className="flex flex-col gap-2">
                <p>
                  A new, empty wiki appears at <span className="font-mono">{slug}</span>, visible to every credential
                  that is not bound to one particular wiki.
                </p>
                <p>
                  <strong>WikiKit has no way to delete a wiki.</strong> The slug is permanent and is the address every
                  link, API call and export filename will carry.
                </p>
              </div>
            }
            confirmLabel="Create wiki"
            ids={{
              dialog: 'space-create-confirm-dialog',
              accept: 'space-create-confirm',
              cancel: 'space-create-confirm-cancel',
              error: 'space-create-error',
            }}
            onConfirm={() => create.mutateAsync()}
          >
            {(open) => (
              <DisabledReason reason={reason} data-testid="space-create-reason">
                <Button
                  variant="accent"
                  data-testid="space-create-submit"
                  disabled={!slugValid || !nameValid || create.isPending}
                  onClick={open}
                >
                  Create wiki
                </Button>
              </DisabledReason>
            )}
          </Confirm>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The settings of one wiki, read fresh.
 *
 * It deliberately re-reads `/v1/spaces/{space}` rather than editing the row the
 * list already holds. The write is a MERGE — `replace: false` — so what this form
 * submits is layered onto whatever the server has now, and a form built from a
 * list snapshot taken ten minutes ago would show one state while writing onto
 * another. The four load states are answered inside the dialog for the same
 * reason they are answered anywhere else: a form that renders blank because a
 * read is in flight is a form somebody will fill in and submit.
 */
function SettingsDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const space = useQuery({ queryKey: keys.space(slug), queryFn: () => wk.spaces.get(slug) })
  const spaces = useQuery({ queryKey: keys.spaces(), queryFn: () => wk.spaces.list() })

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent data-testid="space-settings-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Settings — <span className="font-mono">{slug}</span>
          </DialogTitle>
          <DialogDescription>
            How this wiki describes itself to agents, which language its search is stemmed in, and which other wikis it
            may read.
          </DialogDescription>
        </DialogHeader>

        <DataState query={space} skeleton={<FormSkeleton />}>
          {(data) => (
            <SettingsForm
              // Re-keyed on the server's own version marker: a fresh read after
              // somebody else's write rebuilds the form from it rather than
              // leaving stale values in state that an effect would then have to
              // synchronise.
              key={data.updated_at}
              space={data}
              siblings={(spaces.data?.items ?? []).map((entry) => entry.slug)}
              onClose={onClose}
            />
          )}
        </DataState>
      </DialogContent>
    </Dialog>
  )
}

function SettingsForm({
  space,
  siblings,
  onClose,
}: {
  space: Space
  siblings: readonly string[]
  onClose: () => void
}) {
  const client = useQueryClient()
  const context = readAgentContext(space.settings)

  const [purpose, setPurpose] = useState(() => readString(space.settings, 'purpose'))
  const [useWhen, setUseWhen] = useState(() => readString(context, 'use_when'))
  const [keywords, setKeywords] = useState(() => readKeywords(context).join(', '))
  const [language, setLanguage] = useState<Language>(() => readLanguage(space.settings) ?? DEFAULT_LANGUAGE)
  const [imports, setImports] = useState<string[]>(() => readImports(space.settings))

  /**
   * Every wiki this one could read, plus any slug it already declares that does
   * not exist yet.
   *
   * The second half is not defensive padding: the server accepts an import
   * naming a wiki nobody has created, on purpose — it is a declaration of intent
   * that degrades to "skipped" until the wiki appears. A checkbox list built only
   * from what exists would silently drop that declaration the first time anybody
   * saved this form.
   */
  const importable = [...new Set([...siblings.filter((entry) => entry !== space.slug), ...imports])].sort()

  const save = useMutation({
    mutationFn: () =>
      wk.spaces.settings(space.slug, {
        settings: {
          purpose: purpose.trim(),
          language,
          imports,
          /*
            Spread, because the merge the server performs is SHALLOW: sending
            `agent_context` replaces the whole object, so anything else stored
            under it — a `description`, an `aliases` list — would be deleted by a
            form that only knows about two of its keys.
          */
          agent_context: { ...context, use_when: useWhen.trim(), keywords: splitList(keywords) },
        },
        /*
          `replace: false` is the whole reason this form is safe to ship without
          modelling every key. `aliases`, `predicate_defs` and `agent_briefing`
          are structured registries that deserve surfaces of their own; until
          they have them, a merge leaves them exactly as they are, where a
          replace would erase them on the first save.
        */
        replace: false,
      }),
    onSuccess: async () => {
      toast({ tone: 'success', title: `Settings saved for ${space.slug}` })
      onClose()
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.spaces() }),
        client.invalidateQueries({ queryKey: keys.space(space.slug) }),
      ])
    },
  })

  const languageChanged = language !== (readLanguage(space.settings) ?? DEFAULT_LANGUAGE)

  return (
    <>
      <div className="flex flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="space-settings-purpose">Purpose</Label>
          <Textarea
            id="space-settings-purpose"
            data-testid="space-settings-purpose"
            value={purpose}
            disabled={save.isPending}
            aria-describedby="space-settings-purpose-help"
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="What this wiki knows about."
          />
          <p id="space-settings-purpose-help" className="text-muted-foreground text-xs">
            One or two sentences. An agent asked to find the right wiki for a task is matched against this.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="space-settings-use-when">Use when</Label>
          <Input
            id="space-settings-use-when"
            data-testid="space-settings-use-when"
            value={useWhen}
            disabled={save.isPending}
            aria-describedby="space-settings-use-when-help"
            onChange={(event) => setUseWhen(event.target.value)}
            placeholder="Questions about deployment, on-call and incident handling."
          />
          <p id="space-settings-use-when-help" className="text-muted-foreground text-xs">
            The situation that should send somebody here rather than to another wiki.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="space-settings-keywords">Keywords</Label>
          <Input
            id="space-settings-keywords"
            data-testid="space-settings-keywords"
            value={keywords}
            disabled={save.isPending}
            aria-describedby="space-settings-keywords-help"
            onChange={(event) => setKeywords(event.target.value)}
            placeholder="kubernetes, on-call, postmortem"
          />
          <p id="space-settings-keywords-help" className="text-muted-foreground text-xs">
            Comma separated. These weigh heaviest when WikiKit picks a wiki for a task, so a handful of exact terms
            beats a paragraph.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="space-settings-language">Search language</Label>
          <Select value={language} disabled={save.isPending} onValueChange={(next) => setLanguage(next as Language)}>
            <SelectTrigger id="space-settings-language" data-testid="space-settings-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LANGUAGES.map((entry) => (
                  <SelectItem
                    key={entry.value}
                    value={entry.value}
                    data-testid={`space-settings-language-${entry.value}`}
                  >
                    {entry.label} — {entry.hint}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            How search reduces words before matching them. Changing it rebuilds the search index for every page and
            source in this wiki.
          </p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Reads from</legend>
          <p className="text-muted-foreground text-xs">
            Other wikis this one may search and link into. A page here can reference a page there only if the wiki is
            declared, so this is a deliberate widening of what readers of this wiki can see.
          </p>
          {importable.length === 0 ? (
            <p className="text-muted-foreground text-xs">There is no other wiki in this installation yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {importable.map((entry) => {
                const checked = imports.includes(entry)
                const missing = !siblings.includes(entry)
                return (
                  <label key={entry} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      data-testid={`space-settings-import-${entry}`}
                      checked={checked}
                      disabled={save.isPending}
                      onCheckedChange={() =>
                        setImports((previous) =>
                          checked ? previous.filter((slug) => slug !== entry) : [...previous, entry].sort(),
                        )
                      }
                    />
                    <span className="font-mono text-xs">{entry}</span>
                    {missing ? (
                      <Badge tone="unknown" data-testid={`space-settings-import-${entry}-missing`}>
                        not created yet
                      </Badge>
                    ) : null}
                  </label>
                )
              })}
            </div>
          )}
        </fieldset>
      </div>

      <DialogFooter data-testid="space-settings-footer">
        <Button variant="outline" data-testid="space-settings-cancel" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Confirm
          title="Save these settings"
          description={`Change how ${space.slug} is described and read.`}
          details={
            <div className="flex flex-col gap-2">
              <p>
                Purpose, use-when and keywords change which wiki an agent is pointed at for a task. Nothing already
                written changes, and no page moves.
              </p>
              <p>
                Reading from{' '}
                {imports.length === 0 ? <>no other wiki</> : <span className="font-mono">{imports.join(', ')}</span>} —
                readers of <span className="font-mono">{space.slug}</span> will see search results and links from those
                wikis.
              </p>
              {languageChanged ? (
                <p>
                  <strong>The search language changes to {language}.</strong> Every stored page and source in this wiki
                  is re-indexed on save — search results will differ afterwards, and nothing about the text itself
                  changes.
                </p>
              ) : null}
            </div>
          }
          confirmLabel="Save settings"
          ids={{
            dialog: 'space-settings-confirm-dialog',
            accept: 'space-settings-confirm',
            cancel: 'space-settings-confirm-cancel',
            error: 'space-settings-error',
          }}
          onConfirm={() => save.mutateAsync()}
        >
          {(open) => (
            <Button variant="accent" data-testid="space-settings-submit" disabled={save.isPending} onClick={open}>
              Save settings
            </Button>
          )}
        </Confirm>
      </DialogFooter>
    </>
  )
}

/** A skeleton in the shape of the form, inside the dialog that is already open. */
function FormSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-2/3" />
    </div>
  )
}
