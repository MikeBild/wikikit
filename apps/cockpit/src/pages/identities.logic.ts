/**
 * The rules behind the identities page, with no DOM attached.
 *
 * There are two of them and they are worth a file. One is the body of `PUT
 * /v1/identities/{provider}/{subject}` — the request that writes a person's
 * reach into this installation, whose shape is not obvious from the rendered
 * form, because on the update path a field the console leaves out is a field
 * the server KEEPS. So the difference between "the operator did not fill this
 * in" and "the operator emptied this on purpose" has to be decided here, per
 * field, or a form quietly does nothing.
 *
 * The other is which of those two things the dialog is actually about to do.
 * The console picks its wording by which button was pressed; the SERVER decides
 * by whether the row exists. Those two answers are allowed to disagree, and
 * when they do the console announces a grant while the server performs an
 * update — over a ceiling somebody already holds.
 */

/**
 * The presets the server's `zUpsertIdentityRequest` accepts for `role`.
 *
 * Stated here as the contract it is rather than derived from the page's caption
 * table: the union is the server's enum, and what the page renders is one
 * presentation of it. `knowledge:approve` and `admin` deliberately have no
 * preset — see the page.
 */
export type RolePreset = 'reader' | 'contributor' | 'reviewer'

/** What the grant dialog holds while somebody is filling it in. */
export interface GrantDraft {
  /** Which control the ceiling was chosen with — the two are exclusive on the wire. */
  mode: 'role' | 'scopes'
  role: RolePreset
  scopes: readonly string[]
  displayName: string
  email: string
}

/**
 * The upsert body, for a grant written from scratch and for one loaded from a
 * stored row.
 *
 * `prefilled` is deliberately NOT "the server will UPDATE". The server settles
 * that by whether the row exists, and the dialog can now work that out for
 * itself (`matchExistingGrant`) — but knowing the server will update says
 * nothing about what an empty box on screen MEANS. That is what this flag is:
 * the form was loaded from the stored row, so every field started at the
 * server's value and an empty one is an operator who emptied it. On a form that
 * started blank the same empty box is just a box nobody typed in, and sending
 * it would wipe a stored value the operator was never shown.
 *
 *  - **`display_name` when prefilled: always sent, even empty.** The name on a
 *    grant is frequently a stale placeholder somebody typed once, and clearing
 *    it is a thing operators do on purpose. Omitting the empty string made the
 *    dialog close on a request that changed nothing, with no error to explain
 *    it — the worst possible answer, because the operator has no way to tell it
 *    apart from success. The column is `not null default ''` (migration 0028)
 *    and the schema puts no minimum on the string, so `''` is a value the
 *    server stores rather than a request it refuses.
 *  - **`display_name` when not prefilled: omitted while empty.** Nothing was
 *    shown to clear. If the row turns out to exist anyway, the omitted key
 *    keeps the stored name — which is the right outcome, not a gap: the dialog
 *    warns that this is an existing person before the operator presses
 *    anything, and a name they never saw is not a name they meant to erase.
 *  - **`email`: `null` when prefilled and emptied, omitted when blank on a
 *    blank form.** Same rule, different spelling, because the column is
 *    nullable: `''` is not NULL, so the wire needs an explicit `null` to say
 *    "clear it" — which `zUpsertIdentityRequest` now accepts, and which is the
 *    same absent-vs-null distinction the proposals API already makes for
 *    `base_revision_id`. Sending `''` instead would be refused (the schema puts
 *    a minimum on the string, deliberately: NULL is this column's one empty).
 */
export function identityGrantBody(draft: GrantDraft, prefilled: boolean): Record<string, unknown> {
  const displayName = draft.displayName.trim()
  const email = draft.email.trim()
  return {
    // Exactly one of `role` or `scopes`: the server answers 422 to a body
    // carrying both, and it expands the preset itself.
    ...(draft.mode === 'role' ? { role: draft.role } : { scopes: draft.scopes }),
    ...(prefilled || displayName ? { display_name: displayName } : {}),
    ...(email ? { email } : prefilled ? { email: null } : {}),
  }
}

/** The one field of a listed grant this module needs to tell admitted from revoked. */
export interface KnownGrant {
  provider: string
  subject: string
  revoked_at: string | null
}

/**
 * The grant the typed provider/subject already addresses, if there is one.
 *
 * The identity of a row IS its provider and subject — that is the primary key
 * the server upserts on — so the moment those two match a row that is already
 * listed, "Grant access" is a misnomer: the request will take the UPDATE path
 * and replace the ceiling that person currently holds. The list this reads is
 * the one the page has already loaded, so nothing is asked of the server to
 * find out.
 *
 * Trimmed on both sides because the submit trims too: what the mutation sends
 * is what this has to be matched against, or the dialog would promise one thing
 * about `alex ` and address another.
 *
 * WHY this is not the same as the revoked-grant check the page already had:
 * that one exists to stop a request the server would refuse (409). This one
 * describes a request the server will happily perform. It changes what the
 * dialog SAYS, never whether it can be sent — an operator re-granting somebody
 * from the top of the page is doing a legitimate thing, and a console that
 * blocked it would be wrong in the other direction.
 */
export function matchExistingGrant<T extends KnownGrant>(
  grants: readonly T[],
  provider: string,
  subject: string,
): T | null {
  const wantedProvider = provider.trim()
  const wantedSubject = subject.trim()
  if (!wantedProvider || !wantedSubject) return null
  return grants.find((row) => row.provider === wantedProvider && row.subject === wantedSubject) ?? null
}

/**
 * What the dialog is about to do, in the server's terms rather than the
 * button's.
 *
 * `'edit'` is reached two ways — the operator opened a row, or they typed one
 * that exists — and both must read as an edit, because the consequence is the
 * same: whatever ceiling is stored gets replaced by whatever this dialog sends.
 * `'restore'` is separated out from `'edit'` because it is the one case the
 * server refuses (409 without `restore:true`), so the page has somewhere else
 * to send the operator.
 */
export type GrantIntent = 'create' | 'edit' | 'restore'

export function grantIntent(prefilled: boolean, existing: KnownGrant | null): GrantIntent {
  if (prefilled) return 'edit'
  if (!existing) return 'create'
  return existing.revoked_at === null ? 'edit' : 'restore'
}
