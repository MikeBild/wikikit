// The wiki loop, driven through the real console against a live deployment.
//
// Read a page → edit it → submit a change → read its diff → approve → see the
// page change. That sequence IS the product; everything else in the console
// exists to serve it. `smoke.sh` proves the console is served and
// `check-cockpit-browser.ts` proves it lays out, and neither of them proves the
// one thing an operator actually comes here to do.
//
// WHY this is a script and not a checklist a person clicks: the checklist in
// scripts/deploy/verify-cockpit-prod.md still exists and still matters for the
// judgements only a human can make — does the wording read right, is the
// confirmation honest. But the mechanical half of it was being skipped because
// running it took twenty minutes of clicking, and a verification nobody runs is
// a verification that does not exist. This part takes forty seconds.
//
//   WIKIKIT_DEPLOY_URL=https://<installation> \
//   WIKIKIT_API_KEY=wk_... \
//   bun scripts/deploy/verify-cockpit-loop.ts
//
// IT WRITES, but only inside a wiki it creates for this run. The `finally`
// block deletes that wiki through the public API, so a successful or failed
// verification never leaves a permanent test category or fixture behind.
import { chromium, type Page } from 'playwright'

const BASE = (process.env.WIKIKIT_DEPLOY_URL ?? process.env.WIKIKIT_URL ?? '').replace(/\/$/, '')
const KEY = process.env.WIKIKIT_API_KEY ?? ''
const STAMP = process.env.VERIFY_STAMP ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
const SPACE = `cockpit-verify-${STAMP}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase()
const SLUG = `cockpit-verification-${STAMP}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')

if (!BASE || !KEY) {
  console.error('✗ WIKIKIT_DEPLOY_URL and WIKIKIT_API_KEY are required. This script signs in and writes.')
  process.exit(2)
}

const ok: string[] = []
const findings: string[] = []
function check(label: string, passed: boolean, detail = ''): void {
  if (passed) ok.push(label)
  else findings.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

/**
 * Sign in the way an operator does, through the funnel.
 *
 * Not by forging a cookie: the redirect chain is part of what this verifies,
 * and a deployment whose `WIKIKIT_PUBLIC_URL` disagrees with where it is
 * actually served fails here — which is a thing worth failing on, not routing
 * around.
 */
async function signIn(page: Page): Promise<{ name: string; scopes: string[] } | null> {
  await page.goto(`${BASE}/v1/identity/cockpit-login?return_to=%2Fcockpit%2F`, { waitUntil: 'domcontentloaded' })
  const apiKey = page.locator('a', { hasText: 'Continue with API key' })
  if (await apiKey.count()) await apiKey.first().click()
  await page.fill('input[name="api_key"]', KEY)
  await page.click('button[type="submit"]')
  await page.waitForURL(/\/cockpit\//, { timeout: 20_000 })
  const body = (await page.evaluate(async () => {
    const response = await fetch('/v1/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    return (await response.json()) as { session: { name: string; scopes: string[] } | null }
  })) as { session: { name: string; scopes: string[] } | null }
  return body.session
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
let wikiCreated = false

try {
  const created = await fetch(`${BASE}/v1/spaces`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ slug: SPACE, name: `Cockpit verification ${STAMP}`, settings: { language: 'en' } }),
  })
  check('a temporary wiki is created for this run', created.status === 201, `HTTP ${created.status}`)
  if (created.status !== 201) throw new Error(`could not create temporary wiki: HTTP ${created.status}`)
  wikiCreated = true

  const session = await signIn(page)
  check('signing in through the funnel lands back in the console', session !== null)
  const scopes = session?.scopes ?? []
  console.log(`› ${BASE} — signed in as ${session?.name} with [${scopes.join(', ')}]`)

  await page.evaluate("window.localStorage.setItem('wikikit-cockpit-locale', 'en')")
  await page.goto(`${BASE}/cockpit/?space=${SPACE}`, { waitUntil: 'networkidle' })
  check('the shell renders', (await page.locator('[data-testid="sidebar"]').count()) > 0)
  check('the operator and their scopes are named', (await page.locator('[data-testid="operator-scopes"]').count()) > 0)

  // The Installation block starts COLLAPSED, and a closed Collapsible does not
  // render its content — so the group is what proves the gating, not the
  // entries inside it. Checking for `nav-api-keys` directly reports a missing
  // block on a session that has one, which is how this check first went wrong.
  const holdsAdmin = scopes.includes('admin') || scopes.includes('*')
  const block = await page.locator('[data-testid="nav-group-installation"]').count()
  check(
    holdsAdmin ? 'admin reveals the Installation block' : 'without admin the Installation block stays hidden',
    holdsAdmin ? block > 0 : block === 0,
    `holdsAdmin=${holdsAdmin} block=${block}`,
  )
  if (holdsAdmin && block > 0) {
    await page.locator('[data-testid="nav-group-installation-toggle"]').click()
    await page.waitForTimeout(500)
    const entries = await Promise.all(
      ['nav-api-keys', 'nav-identities', 'nav-webhooks'].map((id) => page.locator(`[data-testid="${id}"]`).count()),
    )
    check(
      'expanding it reveals every administrative page',
      entries.every((count) => count > 0),
      entries.join(','),
    )
  }

  await page.click('[data-testid="nav-pages"]')
  await page.waitForTimeout(800)
  check('?space= survives a sidebar click', new URL(page.url()).searchParams.get('space') === SPACE, page.url())

  // ---- the loop ------------------------------------------------------------
  await page.goto(`${BASE}/cockpit/pages/new?space=${SPACE}`, { waitUntil: 'networkidle' })
  await page.fill('[data-testid="page-edit-title"]', `Cockpit verification ${STAMP}`)
  await page.fill(
    '[data-testid="page-edit-summary"]',
    'Written by the automated cockpit verification run. Safe to delete.',
  )
  await page.fill(
    '[data-testid="page-edit-markdown"]',
    `# Cockpit verification\n\nWritten by \`scripts/deploy/verify-cockpit-loop.ts\` against a live deployment, run ${STAMP}.\n\n- It exists to prove the wiki loop works end to end: edit, submit, review, approve.\n- It states nothing about this wiki's subject and is safe to delete.\n`,
  )

  const submit = page.locator('[data-testid="page-edit-submit"]')
  check('the submit control says "Submit change", not "Save"', (await submit.count()) > 0)
  await submit.click()
  await page.waitForTimeout(600)

  const confirmation = await page.locator('[role="alertdialog"], [role="dialog"]').first().innerText()
  check('the confirmation says it publishes nothing', /does not publish/i.test(confirmation), confirmation.slice(0, 90))
  await page.locator('[data-testid="page-edit-submit-accept"]').click()
  await page.waitForURL(/\/cockpit\/decisions\/proposals\//, { timeout: 20_000 })
  check(
    'submitting lands on the proposal it made',
    /\/decisions\/proposals\/[0-9a-f-]{36}/.test(page.url()),
    page.url(),
  )

  await page.waitForTimeout(1500)
  const change = await page.locator('[data-testid="page"]').innerText()
  check('the change renders a line diff of the new page', change.includes('Cockpit verification') && /\+/.test(change))
  check('the lint result is present', /check|lint|finding/i.test(change))
  check('the public review address is offered', (await page.locator('[data-testid="change-review-url"]').count()) > 0)

  const approve = page.locator('[data-testid="approve"]')
  if (!(await approve.count())) {
    findings.push('no Approve control — this credential cannot publish, so the loop stopped at the diff')
  } else {
    await approve.click()
    await page.waitForTimeout(600)
    const effect = await page.locator('[role="alertdialog"], [role="dialog"]').first().innerText()
    check('the approval confirmation names what it publishes', /page/i.test(effect), effect.slice(0, 120))
    await page.locator('[data-testid="approve-confirm"]').click()
    await page.waitForTimeout(3000)

    await page.goto(`${BASE}/cockpit/pages/${SLUG}?space=${SPACE}`, { waitUntil: 'networkidle' })
    const published = await page
      .locator('.wk-doc')
      .first()
      .innerText()
      .catch(() => '')
    check('the approved page exists and reads back', published.includes('Cockpit verification'), published.slice(0, 80))
  }
} finally {
  await browser.close()
  if (wikiCreated) {
    const removed = await fetch(`${BASE}/v1/spaces/${encodeURIComponent(SPACE)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm_slug: SPACE }),
    }).catch(() => null)
    check('the temporary wiki is deleted in teardown', removed?.status === 204, `HTTP ${removed?.status ?? 'error'}`)
  }
}

console.log(`\n\x1b[32m✓ ${ok.length} checks passed\x1b[0m`)
for (const line of ok) console.log(`   ✓ ${line}`)
if (findings.length) {
  console.log(`\n\x1b[31m✗ ${findings.length} findings\x1b[0m`)
  for (const line of findings) console.log(`   ✗ ${line}`)
  process.exit(1)
}
console.log(`\n  temporary wiki ${SPACE} was removed.`)
