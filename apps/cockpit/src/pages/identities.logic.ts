/**
 * The rules behind the identities page, with no DOM attached.
 *
 * There is one of them and it is worth a file: the body of `PUT
 * /v1/identities/{provider}/{subject}`. That request is how a person's reach
 * into this installation is written, and its shape is not obvious from the
 * rendered form, because the server's UPDATE is `COALESCE($4, display_name)` —
 * a field the console leaves out is a field the server KEEPS. Which means the
 * difference between "the operator did not fill this in" and "the operator
 * emptied this on purpose" has to be decided here, per field, or a form quietly
 * does nothing.
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
 * The upsert body, for a new grant and for a change to an existing one.
 *
 * `editing` is not decoration. The same endpoint creates and updates, but the
 * two paths treat an absent key oppositely — INSERT substitutes the column
 * default, UPDATE keeps whatever is already stored — so each optional field has
 * to be decided against the path it will take:
 *
 *  - **`display_name` when editing: always sent, even empty.** The name on a
 *    grant is frequently a stale placeholder somebody typed once, and clearing
 *    it is a thing operators do on purpose. Omitting the empty string made the
 *    dialog close on a request that changed nothing, with no error to explain
 *    it — the worst possible answer, because the operator has no way to tell it
 *    apart from success. The column is `not null default ''` (migration 0028)
 *    and the schema puts no minimum on the string, so `''` is a value the
 *    server stores rather than a request it refuses.
 *  - **`display_name` when creating: omitted while empty, deliberately.** There
 *    is nothing to clear on a row that does not exist yet, and the INSERT
 *    substitutes exactly the same `''`. Sending it would be the console
 *    claiming the operator supplied a name they never typed. The one seam: the
 *    SERVER decides create-vs-update by whether the row exists, and the console
 *    decides it by which button was pressed — type an existing ACTIVE
 *    provider/subject into "Grant access" and the server takes the UPDATE path,
 *    where the omitted key keeps the stored name. That leaves the list showing a
 *    name the dialog did not, which is worth knowing about and is not worth
 *    fixing by sending `''`: it would silently wipe a name the operator never
 *    saw.
 *  - **`email`: omitted while empty on both paths.** Not for symmetry — the
 *    column is nullable, `''` is not the same value as NULL, and the wire type
 *    (`email: string | null`) has no way to say "clear it". Sending `''` would
 *    put a second kind of empty into a nullable column to work around a gap in
 *    the contract. Clearing an email needs the server to accept `null` first.
 */
export function identityGrantBody(draft: GrantDraft, editing: boolean): Record<string, unknown> {
  const displayName = draft.displayName.trim()
  const email = draft.email.trim()
  return {
    // Exactly one of `role` or `scopes`: the server answers 422 to a body
    // carrying both, and it expands the preset itself.
    ...(draft.mode === 'role' ? { role: draft.role } : { scopes: draft.scopes }),
    ...(editing || displayName ? { display_name: displayName } : {}),
    ...(email ? { email } : {}),
  }
}
