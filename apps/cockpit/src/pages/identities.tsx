import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RotateCcw, UserPlus, Users, UserX } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ApiError } from '@/api/client'
import { keys, wk } from '@/api/wk'
import { Page } from '@/app/shell'
import { Confirm } from '@/components/confirm'
import { SegmentedControl } from '@/components/controls'
import { DisabledReason } from '@/components/disabled-reason'
import { EmptyState } from '@/components/empty-state'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Label } from '@/components/ui/label'
import { RelativeTime } from '@/components/ui/relative-time'
import { useTableView } from '@/hooks/use-table-view'
import { useUrlFilters } from '@/hooks/use-url-filters'
import { firstPage, resetPage, type CursorPage } from '@/lib/cursor'
import { describeFailure } from '@/lib/failure'
import { VALID_SCOPES } from '@/lib/scopes'
import { useCan, useSession } from '@/lib/session'
import { compareText, compareTime } from '@/lib/table-view'
import { STATUS_STATE, type DomainState } from '@/lib/tokens'
import type { FilterSpec } from '@/lib/url-filters'
import { identityGrantBody, type RolePreset } from '@/pages/identities.logic'

/**
 * Who may sign in, and how far they reach once they have.
 *
 * An identity grant is the SINGLE authorization truth for a person. It is not a
 * hint the login provider can overrule and not a cache of something the IdP
 * knows: WikiKit reads the stored ceiling on every request, so a scope taken
 * away here is gone on the person's very next call, and a grant revoked here
 * takes their live sessions and their SSO-minted API keys down with it. That is
 * the sentence this page exists to make visible before somebody presses
 * anything, and it is why the ceiling is a column rather than something folded
 * away behind a row.
 */

/** Derived from the facade so a field the server stops sending stops compiling. */
type IdentityGrant = Awaited<ReturnType<typeof wk.identities.list>>['items'][number]

/** The five domain states as badge tones. See `sources.tsx` for the same table. */
const BADGE_TONE = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
} as const satisfies Record<DomainState, string>

/**
 * The ceiling a person may be given.
 *
 * The knowledge scopes plus `admin`, and NOT `*` — the server's rule rather
 * than a simplification (`zIdentityScope`). `admin` is an authority somebody
 * can enumerate and audit; `*` is "everything, including whatever is added
 * later", which belongs to a key minted on the host where the act itself is
 * the record.
 *
 * Derived from `VALID_SCOPES` rather than retyped, so a scope the alphabet
 * loses stops being offered here on the same day.
 */
const CEILING_SCOPES = VALID_SCOPES.filter((scope) => scope !== '*')

/**
 * What each scope costs the person granting it, in the words of somebody about
 * to tick a box.
 *
 * `admin` gets the longest sentence on purpose: it is the only one here that
 * reaches back at the credentials themselves, and a checkbox that says nothing
 * is a checkbox people tick.
 */
const SCOPE_NOTE: Readonly<Record<string, string>> = {
  'knowledge:read': 'Read every page, source and change in every wiki they can see.',
  'knowledge:propose': 'Add documents and submit changes. Nothing they write becomes knowledge on its own.',
  'knowledge:review': 'Inspect a change in full and send it back with a note.',
  'knowledge:approve': 'Publish knowledge. What they approve is what agents will answer from.',
  admin:
    'Everything above, plus API keys, identity grants and webhooks — including this page. Someone who takes over their account at the identity provider takes over the installation.',
}

/**
 * What each preset expands to, restated for the reader.
 *
 * The expansion happens on the SERVER — only `role` is sent — so this table is a
 * caption, not an authorization decision. `knowledge:approve` deliberately has
 * no preset: approving a change is what publishes knowledge, and the product
 * refuses to let that arrive as a side effect of picking a friendly-sounding
 * word.
 */
const ROLE_PRESETS = [
  { id: 'reader', label: 'Reader', scopes: 'knowledge:read' },
  { id: 'contributor', label: 'Contributor', scopes: 'knowledge:read, knowledge:propose' },
  { id: 'reviewer', label: 'Reviewer', scopes: 'knowledge:read, knowledge:propose, knowledge:review' },
] as const satisfies readonly { id: RolePreset; label: string; scopes: string }[]

/** Where the grant came from. Provenance, never a verdict — so every tone is neutral. */
const SOURCE_WORDS: Record<string, string> = {
  admin: 'Granted here',
  seed: 'Seeded at deploy',
  signup: 'Self sign-up',
  bootstrap: 'Bootstrap',
}

const STATUS_FILTER: readonly FilterSpec[] = [{ key: 'status', values: ['active', 'revoked'], fallback: 'all' }]

const STATUS_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Admitted' },
  { id: 'revoked', label: 'Revoked' },
] as const

/**
 * Admitted or revoked, in the vocabulary `@/lib/tokens` already has.
 *
 * `removed` and not `failed`: an administrator withdrew this person's access on
 * purpose. Nothing failed, and a list where every departed colleague wears the
 * failure colour is a list nobody scans for real trouble.
 */
function grantState(grant: IdentityGrant): DomainState {
  return STATUS_STATE[grant.revoked_at ? 'removed' : 'active'] ?? 'unknown'
}

/** How a person is addressed when the IdP sent no display name. */
function personLabel(grant: IdentityGrant): string {
  return grant.display_name || grant.email || grant.subject
}

export function IdentitiesPage() {
  const can = useCan()
  const session = useSession()
  const queryClient = useQueryClient()

  const [page, setPage] = useState<CursorPage>(firstPage)
  const [granting, setGranting] = useState(false)
  /** The grant whose ceiling is being changed, or null while a new one is being written. */
  const [editing, setEditing] = useState<IdentityGrant | null>(null)
  const { filters, setFilters } = useUrlFilters('identities', STATUS_FILTER)
  // `decodeFilters` guarantees one of the spec's values or the fallback.
  const status = (filters.status ?? 'all') as (typeof STATUS_OPTIONS)[number]['id']

  const identitiesQuery = useQuery({ queryKey: keys.identities(), queryFn: () => wk.identities.list() })

  const mayAdmin = can('admin')

  const revoke = useMutation({
    mutationFn: (grant: IdentityGrant) => wk.identities.revoke(grant.provider, grant.subject),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.identities() }),
    // No `onError` toast: `Confirm` prints the server's words in the dialog the
    // operator is standing in, and two reports of one refusal is one too many.
  })

  const restore = useMutation({
    mutationFn: (grant: IdentityGrant) =>
      // `restore: true` is the ONLY thing that clears a revocation — a plain PUT
      // onto a revoked grant answers 409 on purpose, so re-admitting somebody
      // can never happen as a side effect of editing their details.
      wk.identities.grant(grant.provider, grant.subject, { restore: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.identities() }),
  })

  const rows = useMemo(() => {
    const items = identitiesQuery.data?.items ?? []
    if (status === 'active') return items.filter((grant) => grant.revoked_at === null)
    if (status === 'revoked') return items.filter((grant) => grant.revoked_at !== null)
    return items
  }, [identitiesQuery.data, status])

  const columns = useMemo<readonly DataColumn<IdentityGrant>[]>(
    () => [
      {
        id: 'person',
        label: 'Person',
        required: true,
        compare: (left, right) => compareText(personLabel(left), personLabel(right)),
        cell: (row) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">{personLabel(row)}</span>
            {/* The email when the IdP sent one, and never a dash instead: an
                identity with no email is addressed by its subject above, and a
                second line saying "—" adds a fact nobody needed. */}
            {row.email ? <span className="text-muted-foreground truncate text-xs">{row.email}</span> : null}
          </div>
        ),
      },
      {
        id: 'status',
        label: 'Status',
        compare: (left, right) => compareText(left.revoked_at, right.revoked_at),
        cell: (row) => (
          // The word as well as the colour (CUI-A11Y-5).
          <Badge tone={BADGE_TONE[grantState(row)]} data-testid={`identity-status-${row.provider}-${row.subject}`}>
            {row.revoked_at ? 'Revoked' : 'Admitted'}
          </Badge>
        ),
      },
      {
        id: 'ceiling',
        label: 'May do',
        cell: (row) => (
          <div className="flex flex-wrap gap-1" data-testid={`identity-ceiling-${row.provider}-${row.subject}`}>
            {/* An empty ceiling is not "no data": it is a stored array that
                denies every login, and it has to read as the lockout it is. */}
            {row.allowed_scopes.length === 0 ? (
              <Badge tone="warning">Nothing — every login denied</Badge>
            ) : (
              row.allowed_scopes.map((scope) => (
                <Badge key={scope} tone="neutral" className="font-mono text-[10px]">
                  {scope}
                </Badge>
              ))
            )}
          </div>
        ),
      },
      {
        id: 'provider',
        label: 'Signs in with',
        compare: (left, right) => compareText(left.provider, right.provider),
        cell: (row) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-xs">{row.provider}</span>
            <code className="text-muted-foreground max-w-[24ch] truncate font-mono text-[11px]">{row.subject}</code>
          </div>
        ),
      },
      {
        id: 'source',
        label: 'Granted by',
        hiddenByDefault: true,
        compare: (left, right) => compareText(left.grant_source, right.grant_source),
        cell: (row) => <Badge tone="neutral">{SOURCE_WORDS[row.grant_source] ?? row.grant_source}</Badge>,
      },
      {
        id: 'last_seen',
        label: 'Last seen',
        descFirst: true,
        compare: (left, right) => compareTime(left.last_seen_at, right.last_seen_at),
        // A grant nobody has used yet is a known fact, not a missing one, so it
        // says "Never" rather than the em dash that means "unmeasured".
        cell: (row) =>
          row.last_seen_at ? (
            <RelativeTime value={row.last_seen_at} data-testid={`identity-seen-${row.provider}-${row.subject}`} />
          ) : (
            <span className="text-muted-foreground text-xs">Never signed in</span>
          ),
      },
      {
        id: 'created',
        label: 'Granted',
        descFirst: true,
        hiddenByDefault: true,
        compare: (left, right) => compareTime(left.created_at, right.created_at),
        cell: (row) => <RelativeTime value={row.created_at} />,
      },
      {
        id: 'actions',
        label: 'Actions',
        headerHidden: true,
        required: true,
        className: 'text-right',
        cell: (row) => (
          <div className="flex justify-end gap-1">
            {row.revoked_at ? (
              <RestoreGrant grant={row} allowed={mayAdmin} onRestore={restore.mutateAsync} />
            ) : (
              <>
                <DisabledReason reason={mayAdmin ? null : 'Needs admin'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`identity-edit-${row.provider}-${row.subject}`}
                    disabled={!mayAdmin}
                    onClick={() => setEditing(row)}
                  >
                    Change ceiling
                  </Button>
                </DisabledReason>
                <RevokeGrant grant={row} allowed={mayAdmin} onRevoke={revoke.mutateAsync} />
              </>
            )}
          </div>
        ),
      },
    ],
    [mayAdmin, restore.mutateAsync, revoke.mutateAsync],
  )

  const view = useTableView('identities', columns)

  return (
    <Page
      title="People"
      description="Who may sign in to this deployment and how far each of them reaches. The ceiling stored here is the only authorization WikiKit reads."
      actions={
        <DisabledReason reason={mayAdmin ? null : 'Needs admin'} data-testid="grant-access-reason">
          <Button data-testid="grant-access" disabled={!mayAdmin} onClick={() => setGranting(true)}>
            <UserPlus data-icon="inline-start" />
            Grant access
          </Button>
        </DisabledReason>
      }
    >
      <DataTable
        testId="identities"
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.provider}:${row.subject}`}
        rowTestId={(row) => `identity-row-${row.provider}-${row.subject}`}
        rowAttributes={(row) => ({ 'data-status': row.revoked_at ? 'revoked' : 'active' })}
        query={identitiesQuery}
        view={view.view}
        onViewChange={view.setView}
        page={page}
        onPageChange={setPage}
        unit="people"
        toolbar={
          <SegmentedControl
            label="Show"
            data-testid="identities-status"
            value={status}
            options={STATUS_OPTIONS}
            onChange={(next) => {
              // A cursor belongs to the result that minted it; a filter change
              // starts the walk again.
              setPage(resetPage())
              setFilters({ status: next })
            }}
          />
        }
        empty={
          status === 'all' ? (
            <EmptyState
              icon={Users}
              framed={false}
              title="Nobody has been granted access"
              description="A person signs in through an identity provider, and this grant is what decides whether that sign-in is allowed and what it may reach. Without a grant here, a successful login still reaches nothing."
              data-testid="identities-empty-state"
              action={
                <DisabledReason reason={mayAdmin ? null : 'Needs admin'}>
                  <Button data-testid="grant-access-empty" disabled={!mayAdmin} onClick={() => setGranting(true)}>
                    <UserPlus data-icon="inline-start" />
                    Grant access
                  </Button>
                </DisabledReason>
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              framed={false}
              title={status === 'active' ? 'Nobody is admitted' : 'Nobody has been revoked'}
              description="This is what the filter is showing, not what the deployment holds. Switch to All to see every grant."
              data-testid="identities-filtered-empty-state"
            />
          )
        }
      />

      <GrantAccess
        /*
          The key is what loads a row into the form, and it is deliberately a
          remount rather than an effect that copies props into state. Copying
          renders twice on every open and then fights the operator on the render
          after they type; a fresh mount reads the row once, in the state
          initialisers, and cannot disagree with itself afterwards.
        */
        key={editing ? `${editing.provider}:${editing.subject}` : 'new'}
        open={granting || editing !== null}
        editing={editing}
        existing={identitiesQuery.data?.items ?? []}
        defaultProvider={session.provider_id}
        onOpenChange={(next) => {
          if (next) return
          setGranting(false)
          setEditing(null)
        }}
      />
    </Page>
  )
}

/**
 * Revoking a person, with the reach of it said out loud.
 *
 * This is the most consequential control in the console that is not a review
 * decision, and the reason is the thing operators most often get wrong about
 * SSO: revoking here is not "they can no longer log in next time". The grant is
 * the single authorization truth, so the live tokens die with it and so does
 * every API key that was minted through this identity — a key bound to a grant
 * cannot outlive the grant. Somebody who revokes expecting a polite lockout at
 * the next sign-in and instead stops a running integration needs to have read
 * that first, which is what `details` is for.
 */
function RevokeGrant({
  grant,
  allowed,
  onRevoke,
}: {
  grant: IdentityGrant
  allowed: boolean
  onRevoke: (grant: IdentityGrant) => Promise<unknown>
}) {
  return (
    <Confirm
      title="Revoke this person's access?"
      description={`${personLabel(grant)} loses access to this deployment the moment you confirm.`}
      destructive
      confirmLabel="Revoke access"
      details={
        <div className="flex flex-col gap-2">
          <p>
            This grant is the only authorization WikiKit reads, so revoking it takes effect immediately and everywhere:
            the sessions this person has open right now stop working mid-request, and any API key minted through this
            identity is killed with it. A key bound to a grant cannot outlive the grant.
          </p>
          <p>
            Signing in again will not help — the provider may still authenticate them, and WikiKit will still refuse.
            Only an explicit restore on this page re-admits them, and it re-admits them at the same ceiling they have
            now.
          </p>
          <p>
            Their work stays. Pages they wrote stay visible, changes they raised stay in the queue, and decisions they
            approved stay approved — revoking access has never rewritten history here.
          </p>
        </div>
      }
      onConfirm={() => onRevoke(grant)}
    >
      {(open) => (
        <DisabledReason reason={allowed ? null : 'Needs admin'}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Revoke ${personLabel(grant)}`}
            data-testid={`identity-revoke-${grant.provider}-${grant.subject}`}
            disabled={!allowed}
            onClick={open}
          >
            <UserX />
          </Button>
        </DisabledReason>
      )}
    </Confirm>
  )
}

/**
 * Re-admitting somebody, behind the same gate as removing them.
 *
 * Restoring is a grant of authority and gets a Confirm for that reason alone —
 * and because of the one thing that surprises: it restores the ceiling the row
 * already carries. Somebody who revoked a reviewer six months ago and restores
 * them today gets a reviewer back, not a reader.
 */
function RestoreGrant({
  grant,
  allowed,
  onRestore,
}: {
  grant: IdentityGrant
  allowed: boolean
  onRestore: (grant: IdentityGrant) => Promise<unknown>
}) {
  return (
    <Confirm
      title="Re-admit this person?"
      description={`${personLabel(grant)} will be able to sign in again.`}
      confirmLabel="Restore access"
      details={
        <div className="flex flex-col gap-2">
          <p>
            The ceiling this grant already carries comes back with it —
            {grant.allowed_scopes.length === 0
              ? ' which is currently empty, so every login would still be denied. Set a ceiling instead of restoring.'
              : ` ${grant.allowed_scopes.join(', ')}. Change it afterwards if that is more than they should have now.`}
          </p>
          <p>
            API keys that were killed when this grant was revoked do not come back. Anything running on one needs a new
            key.
          </p>
        </div>
      }
      onConfirm={() => onRestore(grant)}
    >
      {(open) => (
        <DisabledReason reason={allowed ? null : 'Needs admin'}>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`identity-restore-${grant.provider}-${grant.subject}`}
            disabled={!allowed}
            onClick={open}
          >
            <RotateCcw data-icon="inline-start" />
            Restore
          </Button>
        </DisabledReason>
      )}
    </Confirm>
  )
}

/**
 * Granting access, and changing what an existing grant reaches.
 *
 * One dialog for both, because they are one request: `PUT
 * /v1/identities/{provider}/{subject}` creates or updates, and the ceiling is
 * written the same way either time. What changes is that the provider and the
 * subject ARE the identity — they address the row — so on an existing grant they
 * are shown and not editable; typing over them would silently write a second
 * person rather than correcting the first.
 *
 * A form dialog rather than a `Confirm`, on the same reading `sources.tsx` sets
 * out: Confirm guards a decision taken on something that already exists, and
 * this is the operator composing one, with every consequence on screen while
 * they compose it rather than after. The consequence that matters — a ceiling
 * takes effect on the person's very next request — is said above the button.
 */
function GrantAccess({
  open,
  editing,
  existing,
  defaultProvider,
  onOpenChange,
}: {
  open: boolean
  editing: IdentityGrant | null
  existing: readonly IdentityGrant[]
  defaultProvider: string | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()

  // Read once, at mount. The caller remounts this on a different row — see the
  // `key` at the call site — so there is nothing here to keep in step later.
  const [provider, setProvider] = useState(editing?.provider ?? defaultProvider ?? '')
  const [subject, setSubject] = useState(editing?.subject ?? '')
  const [displayName, setDisplayName] = useState(editing?.display_name ?? '')
  const [email, setEmail] = useState(editing?.email ?? '')
  // An existing grant opens on its exact scopes rather than on a preset: a
  // ceiling that was spelled out scope by scope must not be silently rounded to
  // the nearest role the moment somebody opens the dialog to read it.
  const [mode, setMode] = useState<'role' | 'scopes'>(editing ? 'scopes' : 'role')
  const [role, setRole] = useState<RolePreset>('reader')
  const [scopes, setScopes] = useState<readonly string[]>(editing?.allowed_scopes ?? ['knowledge:read'])

  const grant = useMutation({
    mutationFn: () =>
      wk.identities.grant(
        provider.trim(),
        subject.trim(),
        // Which fields the body carries is decided in `identities.logic.ts`,
        // because the answer depends on the server's COALESCE and not on
        // anything visible in this form.
        identityGrantBody({ mode, role, scopes, displayName, email }, editing !== null),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.identities() })
      onOpenChange(false)
    },
  })

  /**
   * A revoked grant already exists for what is being typed.
   *
   * Worth catching here rather than letting the 409 explain it: the server's
   * answer says "pass restore:true", which is a sentence about a request body
   * and not about anything the operator can press. Re-admitting is a decision
   * with its own confirmation on the row, and this points at it.
   */
  const collision =
    editing === null
      ? (existing.find(
          (row) => row.provider === provider.trim() && row.subject === subject.trim() && row.revoked_at !== null,
        ) ?? null)
      : null

  const problem =
    provider.trim().length === 0
      ? 'Name the identity provider'
      : subject.trim().length === 0
        ? 'Give the subject the provider sends'
        : mode === 'scopes' && scopes.length === 0
          ? 'A grant with no scopes denies every login'
          : collision
            ? 'This person has a revoked grant — restore it from the list instead'
            : null

  const refusal = grant.error
    ? describeFailure({
        status: grant.error instanceof ApiError ? grant.error.status : null,
        message: grant.error instanceof Error ? grant.error.message : String(grant.error),
        actions: grant.error instanceof ApiError ? grant.error.nextBestActions : [],
      })
    : null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A request in the air is never dismissed: the answer is what closes
        // this, or an operator is left not knowing whether they granted access.
        if (grant.isPending) return
        grant.reset()
        onOpenChange(next)
      }}
    >
      <DialogContent data-testid="grant-dialog" closeDisabled={grant.isPending} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Change what this person reaches' : 'Grant access'}</DialogTitle>
          <DialogDescription>
            WikiKit reads this ceiling on every request, so whatever you set here is in force on this person's next call
            — there is no session to wait out and nothing to re-issue.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor="grant-provider">Identity provider</Label>
              <Input
                id="grant-provider"
                data-testid="grant-provider"
                value={provider}
                disabled={editing !== null}
                placeholder="entra"
                onChange={(event) => setProvider(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                The id of a provider this deployment is configured to authenticate against. Anything else is refused — a
                typo would otherwise create a grant no login can ever match.
              </p>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor="grant-subject">Subject</Label>
              <Input
                id="grant-subject"
                data-testid="grant-subject"
                value={subject}
                disabled={editing !== null}
                placeholder="00000000-0000-0000-0000-000000000000"
                onChange={(event) => setSubject(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                The stable id the provider sends for this person — not their email, which they can change.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor="grant-name">Name (optional)</Label>
              <Input
                id="grant-name"
                data-testid="grant-name"
                value={displayName}
                placeholder="How this row should read"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor="grant-email">Email (optional)</Label>
              <Input
                id="grant-email"
                data-testid="grant-email"
                type="email"
                inputMode="email"
                value={email}
                placeholder="person@example.com"
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {/* Not a <Label>: what follows is a group of controls rather than
                one labelable field, so each group carries its own aria-label. */}
            <span className="text-sm leading-none font-medium">How far may they reach?</span>
            <SegmentedControl
              label="How to choose the ceiling"
              data-testid="grant-mode"
              value={mode}
              options={[
                { id: 'role' as const, label: 'A preset' },
                { id: 'scopes' as const, label: 'Exact scopes' },
              ]}
              onChange={setMode}
            />
            {mode === 'role' ? (
              <div className="flex flex-col gap-2" role="radiogroup" aria-label="Role preset">
                {ROLE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={role === preset.id}
                    data-testid={`grant-role-${preset.id}`}
                    onClick={() => setRole(preset.id)}
                    className={`flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left ${
                      role === preset.id ? 'border-accent bg-accent/10' : 'border-border hover:bg-muted'
                    }`}
                  >
                    <span className="text-sm font-medium">{preset.label}</span>
                    <span className="text-muted-foreground font-mono text-[11px]">{preset.scopes}</span>
                  </button>
                ))}
                <p className="text-muted-foreground text-xs">
                  No preset can approve a change or administer this installation. Approving is what publishes knowledge
                  and <code className="mx-1 font-mono">admin</code> reaches the credentials themselves, so
                  <code className="mx-1 font-mono">knowledge:approve</code> and
                  <code className="mx-1 font-mono">admin</code>
                  are chosen scope by scope, on purpose.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Scopes">
                  {CEILING_SCOPES.map((scope) => {
                    const chosen = scopes.includes(scope)
                    return (
                      <button
                        key={scope}
                        type="button"
                        aria-pressed={chosen}
                        data-testid={`grant-scope-${scope}`}
                        onClick={() =>
                          setScopes(chosen ? scopes.filter((entry) => entry !== scope) : [...scopes, scope])
                        }
                        // `admin` is the one that reaches back at the
                        // credentials, so it is the one that must not look
                        // like the others when chosen.
                        className={`rounded-4xl border px-2 py-0.5 font-mono text-[11px] ${
                          chosen
                            ? scope === 'admin'
                              ? 'border-warning bg-warning/15 text-warning'
                              : 'border-accent bg-accent/15 text-accent'
                            : 'border-border text-muted-foreground'
                        }`}
                      >
                        {scope}
                      </button>
                    )
                  })}
                </div>
                {/* One line per CHOSEN scope, not a legend of all five: a
                    reader who has picked two scopes is deciding about those
                    two, and a wall of text about the other three is a wall
                    they learn to skip. */}
                <ul className="flex flex-col gap-1">
                  {scopes.map((scope) => (
                    <li key={scope} className="text-muted-foreground text-xs" data-testid={`grant-scope-note-${scope}`}>
                      <code className="font-mono">{scope}</code> — {SCOPE_NOTE[scope] ?? 'No description.'}
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-xs">
                  <code className="font-mono">*</code> can never be granted to a person — it means “everything,
                  including whatever is added later”, which is a grant nobody can audit. That stays a key somebody
                  minted on the host.
                </p>
              </div>
            )}
          </div>

          {collision ? (
            <Alert tone="warning" title="This person already has a revoked grant" data-testid="grant-collision">
              Granting again would be refused. Restore {personLabel(collision)} from the list instead — it re-admits
              them at the ceiling that grant already carries.
            </Alert>
          ) : null}

          {refusal ? (
            <Alert tone={refusal.tone} title={refusal.title} actions={refusal.actions} data-testid="grant-refusal">
              {refusal.message}
            </Alert>
          ) : null}
        </div>

        <DialogFooter data-testid="grant-footer">
          <Button
            variant="outline"
            data-testid="grant-cancel"
            disabled={grant.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <DisabledReason reason={problem}>
            {/* The label stays the promise it made while the request is in the
                air (CUI-ACT-5); the spinner is what says it is working. */}
            <Button
              data-testid="grant-submit"
              disabled={problem !== null || grant.isPending}
              aria-busy={grant.isPending}
              onClick={() => grant.mutate()}
            >
              {grant.isPending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              {editing ? 'Set ceiling' : 'Grant access'}
            </Button>
          </DisabledReason>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
