// Test-side entry point for the deterministic FakeProvider.
//
// The implementation lives in src/llm/fake.ts (CONTRACTS.md §3.3) so that
// non-test code (composition root, integration harnesses) can import it
// without reaching into test/. This module is the ergonomic path for unit
// tests plus a home for small fixture-loading helpers.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export { createFakeProvider, type FakeCall, type FakeProvider } from '../../src/llm/fake.ts'

const fixturesDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'fixtures', 'llm')

/** Load a canned JSON fixture from test/fixtures/llm/ (e.g. 'classify.output.json'). */
export function loadLlmFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T
}
