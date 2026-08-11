import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ApiError } from '@/api/client'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { SegmentedControl } from '@/components/controls'
import { CopyButton } from '@/components/copy-button'
import { FieldLabel } from '@/components/context-help'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Alert } from '@/components/ui/alert'
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
import { Input } from '@/components/ui/input'
import { Field, FieldDescription, FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { RelativeTime } from '@/components/ui/relative-time'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { useTableView } from '@/hooks/use-table-view'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { firstPage, resetPage, type CursorPage } from '@/lib/cursor'
import { describeFailure } from '@/lib/failure'
import { VALID_SCOPES } from '@/lib/scopes'
import { useCan } from '@/lib/session'
import { useSpace } from '@/lib/space'
import { compareText, compareTime } from '@/lib/table-view'
import { STATUS_STATE, type DomainState } from '@/lib/tokens'
import type { FilterSpec } from '@/lib/url-filters'

/**
 * The credentials that reach WikiKit without a browser.
 *
 * An API key is what an agent, a connector or a script presents; a person
 * presents an SSO identity instead. So this page is an inventory and two verbs —
 * mint one, and stop one — and the whole design turns on a single fact of the
 * API: `POST /v1/api-keys` answers with the plaintext key ONE TIME and WikiKit
 * stores only its hash. Nothing on this page can ever show that string again, so
 * the create flow does not close on success; it stops and hands the operator the
 * value with somewhere to put it.
 */

/** Derived from the facade so a field the server stops sending stops compiling. */
type ApiKey = Awaited<ReturnType<typeof wk.keys.list>>['items'][number]

/** The five domain states as badge tones. See `sources.tsx` for the same table. */
const BADGE_TONE = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
} as const satisfies Record<DomainState, string>

/**
 * The scopes a key may be minted with.
 *
 * `VALID_SCOPES` is the console's mirror of the server's closed alphabet, and
 * `*` is filtered out rather than offered: `zCreateApiKeyRequest` does not
 * accept it, so a control for it would be a control whose only outcome is a 400.
 * The order is the server's — read, propose, review, approve, admin — because it
 * is an escalation ladder and reading it as one is how an operator notices they
 * are about to hand out more than they meant to.
 */
const MINTABLE_SCOPES = VALID_SCOPES.filter((scope) => scope !== '*')

/**
 * What each role preset expands to, restated for the reader.
 *
 * The expansion happens on the SERVER, in `ROLE_SCOPES`, and only `role` is sent
 * — so this table is a caption and never an authorization decision: getting it
 * wrong would print the wrong sentence, not mint the wrong key. It is here
 * because a preset whose contents are invisible is a preset nobody can audit,
 * and "reviewer" is exactly the word an operator would guess includes approving.
 * It does not — `knowledge:approve` has no preset at all and must be spelled out
 * scope by scope, which is the server's rule and the reason this list stops at
 * three.
 */
const ROLE_PRESETS = [
  { id: 'reader', label: 'Reader', scopes: 'knowledge:read' },
  { id: 'contributor', label: 'Contributor', scopes: 'knowledge:read, knowledge:propose' },
  { id: 'reviewer', label: 'Reviewer', scopes: 'knowledge:read, knowledge:propose, knowledge:review' },
] as const

type RolePreset = (typeof ROLE_PRESETS)[number]['id']

const STATUS_FILTER: readonly FilterSpec[] = [{ key: 'status', values: ['active', 'revoked'], fallback: 'all' }]

const STATUS_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Live' },
  { id: 'revoked', label: 'Revoked' },
] as const

/**
 * Live or withdrawn, in the vocabulary `@/lib/tokens` already has.
 *
 * A revoked key takes `removed`'s state and not `failed`'s, deliberately:
 * somebody withdrew the credential on purpose, nothing went wrong, and a table
 * where every retired key wears the failure colour is a table an operator stops
 * reading for actual failures.
 */
function keyState(key: ApiKey): DomainState {
  return STATUS_STATE[key.revoked_at ? 'removed' : 'active'] ?? 'unknown'
}

export function ApiKeysPage() {
  const can = useCan()
  const queryClient = useQueryClient()
  /**
   * The wiki the sidebar is on — offered as the BINDING for a new key, never as
   * a picker. A space-scoped key is the console's answer to "this connector
   * should only reach one wiki", and the wiki it means is the one on screen; a
   * second selector here would be a page arguing with the sidebar about which
   * wiki the operator is in.
   */
  const space = useSpace()

  const [page, setPage] = useState<CursorPage>(firstPage)
  const [minting, setMinting] = useState(false)
  const { filters, setFilters } = useUrlFilters('api-keys', STATUS_FILTER)
  // `decodeFilters` guarantees one of the spec's values or the fallback, so the
  // narrowing is a restatement of a rule `lib/url-filters.ts` already enforces
  // — not a claim this page is making about an arbitrary search parameter.
  const status = (filters.status ?? 'all') as (typeof STATUS_OPTIONS)[number]['id']

  const keysQuery = useQuery({ queryKey: keys.apiKeys(), queryFn: () => wk.keys.list() })

  const mayAdmin = can('admin')

  const revoke = useMutation({
    mutationFn: (id: string) => wk.keys.revoke(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.apiKeys() }),
    // No `onError` toast: `Confirm` awaits this and prints the server's own
    // words inside the dialog the operator is still standing in. A toast as
    // well would report one refusal twice, and one of the two auto-dismisses.
  })

  const rows = useMemo(() => {
    const items = keysQuery.data?.items ?? []
    if (status === 'active') return items.filter((key) => key.revoked_at === null)
    if (status === 'revoked') return items.filter((key) => key.revoked_at !== null)
    return items
  }, [keysQuery.data, status])

  const columns = useMemo<readonly DataColumn<ApiKey>[]>(
    () => [
      {
        id: 'name',
        label: 'Key',
        required: true,
        className: 'max-w-44 whitespace-normal',
        compare: (left, right) => compareText(left.name, right.name),
        cell: (row) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">{row.name}</span>
          </div>
        ),
      },
      {
        id: 'status',
        label: 'Status',
        compare: (left, right) => compareText(left.revoked_at, right.revoked_at),
        cell: (row) => (
          // The word as well as the colour (CUI-A11Y-5).
          <Badge tone={BADGE_TONE[keyState(row)]}>{row.revoked_at ? 'Revoked' : 'Live'}</Badge>
        ),
      },
      {
        id: 'scopes',
        label: 'Scopes',
        priority: 'optional',
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {row.scopes.map((scope) => (
              <Badge key={scope} tone="neutral" className="font-mono text-[10px]">
                {scope}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: 'space',
        label: 'Reaches',
        priority: 'optional',
        compare: (left, right) => compareText(left.space ?? '', right.space ?? ''),
        // `null` here is a MEASURED fact and not a missing one, so it is not an
        // em dash: the server means "this key is valid in every wiki", which is
        // the wider authority of the two and must never read as an absence.
        cell: (row) =>
          row.space ? (
            <span className="font-mono text-xs">{row.space}</span>
          ) : (
            <span className="text-muted-foreground text-xs">Every wiki</span>
          ),
      },
      {
        id: 'last_used',
        label: 'Last used',
        priority: 'optional',
        descFirst: true,
        compare: (left, right) => compareTime(left.last_used_at, right.last_used_at),
        // Same reading as `space`: a key nobody has presented yet has a known
        // history, and "Never" says it. An em dash would claim WikiKit does not
        // know, and it does.
        cell: (row, index) =>
          row.last_used_at ? (
            <RelativeTime value={row.last_used_at} data-testid={`api-keys-row-${index + 1}-used`} />
          ) : (
            <span className="text-muted-foreground text-xs">Never</span>
          ),
      },
      {
        id: 'created',
        label: 'Minted',
        descFirst: true,
        hiddenByDefault: true,
        compare: (left, right) => compareTime(left.created_at, right.created_at),
        cell: (row, index) => <RelativeTime value={row.created_at} data-testid={`api-keys-row-${index + 1}-created`} />,
      },
      {
        id: 'actions',
        label: 'Actions',
        headerHidden: true,
        required: true,
        className: 'text-right',
        cell: (row, index) => (
          <RevokeKey
            apiKey={row}
            allowed={mayAdmin}
            testId={`api-keys-row-${index + 1}-revoke`}
            onRevoke={revoke.mutateAsync}
          />
        ),
      },
    ],
    [mayAdmin, revoke.mutateAsync],
  )

  const view = useTableView('api-keys', columns)

  return (
    <Page
      title="API keys"
      description="The credentials that reach WikiKit without a browser — what each one may do, where it may do it, and how to stop it."
      actions={
        <DisabledReason reason={mayAdmin ? null : 'Needs admin'} data-testid="mint-key-reason">
          <Button data-testid="mint-key" disabled={!mayAdmin} onClick={() => setMinting(true)}>
            <Plus data-icon="inline-start" />
            Mint a key
          </Button>
        </DisabledReason>
      }
    >
      <DataTable
        testId="api-keys"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        rowTestId={(_row, index) => `api-keys-row-${index + 1}`}
        rowAttributes={(row) => ({ 'data-status': row.revoked_at ? 'revoked' : 'active' })}
        query={keysQuery}
        view={view.view}
        onViewChange={view.setView}
        page={page}
        onPageChange={setPage}
        unit="keys"
        toolbar={
          <SegmentedControl
            label="Show"
            data-testid="api-keys-status"
            value={status}
            options={STATUS_OPTIONS}
            onChange={(next) => {
              // The window belongs to the result that produced it: a filter
              // change that kept the cursor would drop the operator into the
              // middle of a list they have not seen the start of.
              setPage(resetPage())
              setFilters({ status: next })
            }}
          />
        }
        empty={
          status === 'all' ? (
            <EmptyState
              icon={KeyRound}
              framed={false}
              title="No API keys"
              description="Create a key for an agent, connector or script."
              data-testid="api-keys-empty-state"
            />
          ) : (
            <EmptyState
              icon={KeyRound}
              framed={false}
              title={status === 'active' ? 'No live keys' : 'No revoked keys'}
              description="This is what the filter is showing, not what the deployment holds. Switch to All to see every key."
              data-testid="api-keys-filtered-empty-state"
            />
          )
        }
      />

      <MintKey space={space} open={minting} onOpenChange={setMinting} />
    </Page>
  )
}

/**
 * Revoking, with the consequence said before the click and not after it.
 *
 * Revocation is immediate and total, and it is the one action on this page that
 * can take a running system off the air: a nightly connector whose key this is
 * stops archiving sources tonight, and the first anyone hears of it is a 401 in
 * somebody else's logs. So `details` names what stops rather than restating what
 * the button says, and it names the way forward — mint a replacement first —
 * because there is no un-revoke.
 */
function RevokeKey({
  apiKey,
  allowed,
  testId,
  onRevoke,
}: {
  apiKey: ApiKey
  allowed: boolean
  testId: string
  onRevoke: (id: string) => Promise<unknown>
}) {
  // A key that is already revoked has nothing left to withdraw. The control
  // stays on screen and says why, rather than vanishing from one row and not
  // the next.
  const already = apiKey.revoked_at !== null
  const reason = !allowed ? 'Needs admin' : already ? 'This key was already revoked' : null

  return (
    <Confirm
      title="Revoke this key?"
      description={`“${apiKey.name}” stops working the moment you confirm.`}
      destructive
      confirmLabel="Revoke key"
      details={
        <div className="flex flex-col gap-2">
          <p>
            Every request that presents this key is refused from now on — reads, proposals, reviews and ingests alike.
            Anything running on it stops: a connector pushing documents, an agent drafting pages, a script polling the
            review queue. Sessions already signed in are unaffected; this is one credential, not a person.
          </p>
          <p>
            Nothing already written is touched. Sources stay archived, pages stay visible, and changes this key raised
            stay in the queue for a human to decide.
          </p>
          <p>
            There is no way back. WikiKit stores a hash and never the key, so a revoked key cannot be re-enabled — mint
            a replacement, hand it to whatever was using this one, and revoke afterwards to avoid a gap.
          </p>
        </div>
      }
      onConfirm={() => onRevoke(apiKey.id)}
    >
      {(open) => (
        <DisabledReason reason={reason} label={`Revoke ${apiKey.name}`} data-testid={`${testId}-tooltip`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Revoke ${apiKey.name}`}
            data-testid={testId}
            disabled={reason !== null}
            onClick={open}
          >
            <Trash2 />
          </Button>
        </DisabledReason>
      )}
    </Confirm>
  )
}

/**
 * Minting a key, and then handing it over.
 *
 * Two states in one dialog, and the second one is the reason this is not a
 * `Confirm`. Minting a credential is not the decision an "are you sure" guards —
 * a key nobody has copied yet reaches nothing — but the ANSWER is a value that
 * exists exactly once in the world, and a dialog that closed on success would
 * destroy it while telling the operator it had succeeded. So the request's
 * outcome replaces the form, the plaintext sits under a warning that says
 * plainly it will not be shown again, and only an explicit acknowledgement
 * closes the panel: while the key is on screen the X is inert and Escape does
 * nothing, for the same reason `Confirm` refuses to close mid-flight.
 */
function MintKey({
  space,
  open,
  onOpenChange,
}: {
  space: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [mode, setMode] = useState<'role' | 'scopes'>('role')
  const [role, setRole] = useState<RolePreset>('reader')
  const [scopes, setScopes] = useState<readonly string[]>(['knowledge:read'])
  const [limitToSpace, setLimitToSpace] = useState(false)
  /** The plaintext, held only until this dialog closes. Never in the query cache. */
  const [minted, setMinted] = useState<string | null>(null)

  const mint = useMutation({
    mutationFn: () =>
      wk.keys.create({
        name: name.trim(),
        // Exactly one of `role` or `scopes` — `zCreateApiKeyRequest` refuses a
        // body carrying both, and the server expands the preset itself.
        ...(mode === 'role' ? { role } : { scopes }),
        ...(limitToSpace ? { space } : {}),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: keys.apiKeys() })
      setMinted(result.key)
    },
  })

  function reset() {
    setName('')
    setMode('role')
    setRole('reader')
    setScopes(['knowledge:read'])
    setLimitToSpace(false)
    setMinted(null)
    mint.reset()
  }

  const problem =
    name.trim().length === 0
      ? 'Give the key a name'
      : mode === 'scopes' && scopes.length === 0
        ? 'Choose at least one scope'
        : null

  const refusal = mint.error
    ? describeFailure({
        status: mint.error instanceof ApiError ? mint.error.status : null,
        message: mint.error instanceof Error ? mint.error.message : String(mint.error),
        actions: mint.error instanceof ApiError ? mint.error.nextBestActions : [],
      })
    : null

  const locked = mint.isPending || minted !== null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A request in the air, or a key on screen that has been shown once and
        // will not be shown again: neither is dismissed by a stray click.
        if (locked) return
        reset()
        onOpenChange(next)
      }}
    >
      <DialogContent data-testid="mint-key-dialog" closeDisabled={locked} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{minted ? 'Copy this key now' : 'Mint an API key'}</DialogTitle>
          <DialogDescription>
            {minted
              ? 'WikiKit stores only a hash of this key. This screen is the one and only place it will ever appear.'
              : 'A key carries scopes, not a role — the presets below are expanded into scopes when the key is minted, and the scopes are what the server checks on every request.'}
          </DialogDescription>
        </DialogHeader>

        {minted ? (
          <div className="flex flex-col gap-3 overflow-y-auto">
            <Alert
              tone="warning"
              title="This key will never be shown again"
              data-testid="minted-key-warning"
              actions={[
                'Put it in your secret store or password manager before you close this.',
                'If you lose it, revoke this key and mint another — it cannot be recovered.',
              ]}
            >
              Closing this panel discards it. WikiKit kept the hash, not the key.
            </Alert>
            <div className="border-border bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
              <code
                data-testid="minted-key-value"
                className="font-mono text-xs break-all select-all"
                // Named for a screen reader, which otherwise reads a wall of
                // base64 with no idea what it is looking at.
                aria-label="The plaintext API key"
              >
                {minted}
              </code>
              <CopyButton value={minted} label="Copy key" data-testid="minted-key-copy" />
            </div>
          </div>
        ) : (
          <FieldGroup className="overflow-y-auto">
            <Field>
              <FieldLabel
                htmlFor="key-name"
                helpTitle="About API key names"
                help={<p>The name identifies this key later; the secret itself is never shown again or stored.</p>}
                testId="key-name-help"
              >
                What is this key for?
              </FieldLabel>
              <Input
                id="key-name"
                data-testid="key-name"
                value={name}
                placeholder="Nightly handbook connector"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>

            <FieldSet>
              {/* Not a <Label>: what follows is a group of controls, not one
                  labelable field, and `htmlFor` pointing at a <div> names
                  nothing. Each group carries its own `aria-label` instead. */}
              <FieldLegend variant="label">What may it do?</FieldLegend>
              <SegmentedControl
                label="How to choose the scopes"
                data-testid="key-mode"
                value={mode}
                options={[
                  { id: 'role' as const, label: 'A preset' },
                  { id: 'scopes' as const, label: 'Exact scopes' },
                ]}
                onChange={setMode}
              />
              {mode === 'role' ? (
                <RadioGroup
                  value={role}
                  onValueChange={(value) => setRole(value as RolePreset)}
                  aria-label="Role preset"
                >
                  {ROLE_PRESETS.map((preset) => (
                    <label
                      key={preset.id}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-muted has-data-checked:border-accent has-data-checked:bg-accent/10"
                    >
                      <RadioGroupItem value={preset.id} data-testid={`key-role-${preset.id}`} />
                      <span className="flex flex-col gap-0.5 text-left">
                        <span className="text-sm font-medium">{preset.label}</span>
                        <span className="text-muted-foreground font-mono text-[11px]">{preset.scopes}</span>
                      </span>
                    </label>
                  ))}
                  <p className="text-muted-foreground text-xs">
                    There is no preset that can approve a change. Approving publishes knowledge, so
                    <code className="mx-1 font-mono">knowledge:approve</code>
                    has to be chosen scope by scope, on purpose.
                  </p>
                </RadioGroup>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Scopes">
                    {MINTABLE_SCOPES.map((scope) => {
                      const chosen = scopes.includes(scope)
                      return (
                        <label
                          key={scope}
                          className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2 py-1.5 font-mono text-[11px] text-muted-foreground has-data-checked:border-accent has-data-checked:bg-accent/10 has-data-checked:text-foreground"
                        >
                          <Checkbox
                            checked={chosen}
                            data-testid={`key-scope-${scope}`}
                            onCheckedChange={() =>
                              setScopes(chosen ? scopes.filter((entry) => entry !== scope) : [...scopes, scope])
                            }
                          />
                          <span>{scope}</span>
                        </label>
                      )
                    })}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    <code className="font-mono">admin</code> reaches every other scope, including minting and revoking
                    keys and deciding who may sign in.
                  </p>
                </div>
              )}
            </FieldSet>

            <Field>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="key-space">Limit it to this wiki</Label>
                <Switch
                  id="key-space"
                  data-testid="key-space"
                  checked={limitToSpace}
                  onCheckedChange={setLimitToSpace}
                  aria-label={`Limit this key to ${space}`}
                />
              </div>
              <FieldDescription>
                {limitToSpace
                  ? `This key will reach ${space} and nothing else.`
                  : 'This key will reach every wiki in this deployment.'}
              </FieldDescription>
            </Field>

            {refusal ? (
              <Alert tone={refusal.tone} title={refusal.title} actions={refusal.actions} data-testid="mint-key-refusal">
                {refusal.message}
              </Alert>
            ) : null}
          </FieldGroup>
        )}

        <DialogFooter data-testid="mint-key-footer">
          {minted ? (
            <Button
              data-testid="minted-key-done"
              onClick={() => {
                reset()
                onOpenChange(false)
              }}
            >
              I have stored it — close
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                data-testid="mint-key-cancel"
                disabled={mint.isPending}
                onClick={() => {
                  reset()
                  onOpenChange(false)
                }}
              >
                Cancel
              </Button>
              <DisabledReason reason={problem}>
                {/* The label does not rewrite itself while the request is in the
                    air (CUI-ACT-5): a spinner says it is working. */}
                <Button
                  data-testid="mint-key-submit"
                  disabled={problem !== null || mint.isPending}
                  aria-busy={mint.isPending}
                  onClick={() => mint.mutate()}
                >
                  {mint.isPending ? <Spinner data-icon="inline-start" /> : null}
                  Mint key
                </Button>
              </DisabledReason>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
