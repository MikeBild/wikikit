// Pending URL-mode review elicitations — the bridge between the MCP session
// that raised elicitation/create (mode: "url") and the REST surface where the
// human's decision actually lands (the /review/{id} page drives the ordinary
// approve/reject/request-changes endpoints). When a terminal review arrives,
// the registry fires the SDK's notifications/elicitation/complete callback on
// exactly the session that initiated the elicitation — the spec's signal that
// the out-of-band interaction finished, so the agent can stop polling.
//
// Deliberately in-process and best-effort: WikiKit is a single binary, the
// spec requires clients to keep working when the completion notification never
// arrives (wikikit_proposals polling stays the durable path), and a notifier
// whose session has meanwhile closed simply rejects and is dropped.
import type { Logger } from '../logger.ts'

/** Backstop against notifier leakage (sessions that never conclude a review):
 *  registrations beyond this evict the oldest — those reviews fall back to
 *  polling, which every caller must support anyway. */
export const MAX_PENDING_ELICITATIONS = 500

export interface PendingUrlElicitation {
  elicitationId: string
  proposalId: string
  sessionId: string | null
  /** SDK callback (createElicitationCompletionNotifier) — awaiting it sends
   *  notifications/elicitation/complete on the originating session. */
  notify: () => Promise<void>
}

export interface ElicitationRegistry {
  register(entry: PendingUrlElicitation): void
  /** Fire-and-forget completion for every pending elicitation of a proposal. */
  complete(proposalId: string): Promise<void>
  /** Drop registrations owned by a closed/evicted session — their transport is gone. */
  pruneSession(sessionId: string): void
  size(): number
}

export function createElicitationRegistry(options: { logger?: Logger } = {}): ElicitationRegistry {
  const pending = new Map<string, PendingUrlElicitation>()

  return {
    register(entry) {
      while (pending.size >= MAX_PENDING_ELICITATIONS) {
        const oldest = pending.keys().next().value
        if (oldest === undefined) break
        pending.delete(oldest)
        options.logger?.warn('pending url elicitation evicted — completion falls back to polling', {
          elicitation_id: oldest,
        })
      }
      pending.set(entry.elicitationId, entry)
    },

    async complete(proposalId) {
      for (const [elicitationId, entry] of pending) {
        if (entry.proposalId !== proposalId) continue
        pending.delete(elicitationId)
        try {
          await entry.notify()
          options.logger?.info('mcp url elicitation completed', {
            elicitation_id: elicitationId,
            proposal_id: proposalId,
            session_id: entry.sessionId,
          })
        } catch (error) {
          // Session closed or stream gone — the client polls instead.
          options.logger?.debug('elicitation completion notification not delivered', {
            elicitation_id: elicitationId,
            proposal_id: proposalId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    },

    pruneSession(sessionId) {
      for (const [elicitationId, entry] of pending) {
        if (entry.sessionId === sessionId) pending.delete(elicitationId)
      }
    },

    size() {
      return pending.size
    },
  }
}
