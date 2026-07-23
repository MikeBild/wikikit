// The URL-elicitation bridge: pending registrations, best-effort completion
// notification, session pruning, and the leak backstop.
import { describe, expect, test } from 'bun:test'
import { createElicitationRegistry, MAX_PENDING_ELICITATIONS } from '../../src/mcp/elicitation-registry.ts'

function entry(overrides: { elicitationId?: string; proposalId?: string; sessionId?: string | null } = {}) {
  const calls: number[] = []
  return {
    calls,
    value: {
      elicitationId: overrides.elicitationId ?? 'e-1',
      proposalId: overrides.proposalId ?? 'p-1',
      sessionId: overrides.sessionId ?? 's-1',
      notify: async () => {
        calls.push(1)
      },
    },
  }
}

describe('elicitation registry', () => {
  test('complete notifies every pending elicitation of the proposal and removes them', async () => {
    const registry = createElicitationRegistry()
    const first = entry({ elicitationId: 'e-1', proposalId: 'p-1' })
    const second = entry({ elicitationId: 'e-2', proposalId: 'p-1', sessionId: 's-2' })
    const other = entry({ elicitationId: 'e-3', proposalId: 'p-OTHER' })
    registry.register(first.value)
    registry.register(second.value)
    registry.register(other.value)

    await registry.complete('p-1')
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(1)
    expect(other.calls).toHaveLength(0)
    expect(registry.size()).toBe(1)

    // Completion is one-shot: a second terminal review finds nothing.
    await registry.complete('p-1')
    expect(first.calls).toHaveLength(1)
  })

  test('a notifier whose session is gone rejects without breaking the completion pass', async () => {
    const registry = createElicitationRegistry()
    registry.register({
      elicitationId: 'e-dead',
      proposalId: 'p-1',
      sessionId: 's-dead',
      notify: async () => {
        throw new Error('transport closed')
      },
    })
    const live = entry({ elicitationId: 'e-live', proposalId: 'p-1' })
    registry.register(live.value)

    await registry.complete('p-1')
    expect(live.calls).toHaveLength(1)
    expect(registry.size()).toBe(0)
  })

  test('pruneSession drops only that session’s registrations', async () => {
    const registry = createElicitationRegistry()
    const pruned = entry({ elicitationId: 'e-1', sessionId: 's-gone' })
    const kept = entry({ elicitationId: 'e-2', sessionId: 's-alive' })
    registry.register(pruned.value)
    registry.register(kept.value)

    registry.pruneSession('s-gone')
    expect(registry.size()).toBe(1)
    await registry.complete('p-1')
    expect(pruned.calls).toHaveLength(0)
    expect(kept.calls).toHaveLength(1)
  })

  test('the cap evicts oldest-first instead of growing without bound', () => {
    const registry = createElicitationRegistry()
    for (let index = 0; index <= MAX_PENDING_ELICITATIONS; index += 1) {
      registry.register(entry({ elicitationId: `e-${index}`, proposalId: `p-${index}` }).value)
    }
    expect(registry.size()).toBe(MAX_PENDING_ELICITATIONS)
  })
})
