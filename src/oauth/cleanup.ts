// Retention sweep for OAuth's short-lived operational rows. Keeping revoked
// refresh tokens for seven days preserves replay detection; after that the
// rows carry no live authorization value and should not grow forever.
import type { Db } from '../db/postgres.ts'

export interface OAuthCleanupReport {
  accessTokens: number
  refreshTokens: number
  authorizationCodes: number
  loginStates: number
  operatorSessions: number
  unusedClients: number
}

export async function cleanupOAuthRows(db: Db): Promise<OAuthCleanupReport> {
  const access = await db.query(
    `DELETE FROM wk_oauth_access_tokens
      WHERE expires_at < now() - interval '7 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
  )
  const refresh = await db.query(
    `DELETE FROM wk_oauth_refresh_tokens
      WHERE expires_at < now() - interval '7 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
  )
  const codes = await db.query(
    `DELETE FROM wk_oauth_authorization_codes
      WHERE expires_at < now() - interval '1 day'`,
  )
  const loginStates = await db.query(
    `DELETE FROM wk_oauth_login_states
      WHERE expires_at < now() - interval '1 day'
         OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 day')`,
  )
  const operatorSessions = await db.query(
    `DELETE FROM wk_oauth_operator_sessions
      WHERE absolute_expires_at < now() - interval '1 day'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '1 day')`,
  )
  const clients = await db.query(
    `DELETE FROM wk_oauth_clients c
      WHERE c.created_at < now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM wk_oauth_access_tokens a WHERE a.client_id = c.client_id)
        AND NOT EXISTS (SELECT 1 FROM wk_oauth_refresh_tokens r WHERE r.client_id = c.client_id)
        AND NOT EXISTS (SELECT 1 FROM wk_oauth_authorization_codes x WHERE x.client_id = c.client_id)`,
  )
  return {
    accessTokens: access.rowCount,
    refreshTokens: refresh.rowCount,
    authorizationCodes: codes.rowCount,
    loginStates: loginStates.rowCount,
    operatorSessions: operatorSessions.rowCount,
    unusedClients: clients.rowCount,
  }
}
