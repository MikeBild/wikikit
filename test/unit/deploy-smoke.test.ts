// The post-deploy smoke test, held against installations that are wrong on
// purpose.
//
// `scripts/deploy/smoke.sh` is the last thing between a release and the claim
// that the release is good, so the failure mode that matters is not "it errors"
// but "it prints a green tick over a broken deployment". A check that cannot be
// made to fail has never been shown to check anything — so every case below
// serves a deliberately broken policy and demands the ✗, and the first case
// serves a correct one and demands that the whole script still exits 0.
//
// The installation is faked rather than mocked: the script is run as a real
// process against a real HTTP server, because everything worth getting wrong
// here lives in how curl's output is parsed, not in how the script is called.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const SMOKE = join(import.meta.dir, '../../scripts/deploy/smoke.sh')

/** The policy `cockpitCsp` actually builds, hash and all. */
const GOOD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'sha256-Zm9vYmFyYmF6'",
  // Present in the real policy and load-bearing for this test: a check that
  // merely looked for the word unsafe-inline anywhere in the header would
  // condemn every correct WikiKit deployment there has ever been.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ')

const SHELL_HTML =
  '<!doctype html><html><head><meta name="cockpit-ui-contract" content="cockpit-ui" />' +
  '<meta name="cockpit-ui-digest" content="sha256-0123456789ab" /></head><body></body></html>'
const CHOOSER_HTML =
  '<!doctype html><html><body><div class="provider-stack"><button>Continue</button></div></body></html>'

const CHOOSER_PATH = '/v1/identity/choose'

/**
 * An installation that passes every check in the script, except for the one
 * fact each test varies.
 *
 * `csp` is null for the deployment that serves no policy at all — the case the
 * script has to treat as a failure rather than as an absence of bad news.
 */
function installation(csp: string | null): (request: Request) => Response {
  return (request) => {
    const path = new URL(request.url).pathname
    const head = request.method === 'HEAD'
    const send = (body: string, init: ResponseInit): Response => new Response(head ? null : body, init) as Response

    switch (path) {
      case '/health':
        return send('ok', { headers: { 'content-type': 'text/plain' } })
      case '/ready':
        return send(JSON.stringify({ status: 'ready', version: '9.9.9' }), {
          headers: { 'content-type': 'application/json' },
        })
      case '/openapi.json':
        return send('{}', { headers: { 'content-type': 'application/json' } })
      case '/llms.txt':
        return send('# wikikit', { headers: { 'content-type': 'text/plain' } })
      case '/.well-known/service-descriptor.json':
        return send('{}', { headers: { 'content-type': 'application/json' } })
      case '/v1/spaces':
        return send('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })
      case '/mcp':
        return send('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="/x"' } })
      case '/v1/session':
        return send('{"session":null}', { headers: { 'content-type': 'application/json' } })
      case '/v1/identity/cockpit-login':
        return send('', { status: 302, headers: { location: CHOOSER_PATH } })
      case CHOOSER_PATH:
        return send(CHOOSER_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      case '/cockpit/':
      case '/cockpit/changes': {
        const headers = new Headers({
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        })
        if (csp !== null) headers.set('content-security-policy', csp)
        return send(SHELL_HTML, { headers })
      }
      default:
        return send('not found', { status: 404 })
    }
  }
}

interface Run {
  code: number
  out: string
}

/**
 * Run the script against a throwaway installation serving `csp`.
 *
 * `Bun.spawn` and not `spawnSync`: the server answering these requests is a
 * JavaScript handler on this very event loop, so a synchronous child that waits
 * for it would wait forever.
 */
async function smoke(csp: string | null): Promise<Run> {
  const server = Bun.serve({ port: 0, fetch: installation(csp) })
  try {
    const proc = Bun.spawn(['bash', SMOKE], {
      env: {
        ...process.env,
        WIKIKIT_DEPLOY_URL: `http://127.0.0.1:${server.port}`,
        // A proxy configured in the developer's environment would answer for
        // the loopback address and every assertion below would be about the
        // proxy instead.
        no_proxy: '*',
        NO_PROXY: '*',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code: await proc.exited, out: out + err }
  } finally {
    await server.stop(true)
  }
}

/** What the script said about one named check. */
function verdict(run: Run, label: string): 'pass' | 'fail' | 'missing' {
  for (const line of run.out.split('\n')) {
    if (!line.includes(label)) continue
    if (line.includes('✓')) return 'pass'
    if (line.includes('✗')) return 'fail'
  }
  return 'missing'
}

const NO_UNSAFE_INLINE = 'the CSP carries no script unsafe-inline'
const BY_HASH = 'the CSP admits the inline theme script by hash'

const HAS_BASH = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0
const HAS_CURL = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0

describe.skipIf(!HAS_BASH || !HAS_CURL)('the deploy smoke test', () => {
  test('a correct installation passes every check', async () => {
    const run = await smoke(GOOD_CSP)
    expect(run.out).not.toContain('✗')
    expect(run.code).toBe(0)
  })

  test('an appended unsafe-inline is caught', async () => {
    // The regression the check exists for, in the shape it would actually
    // arrive in: `cockpitCsp` puts 'self' first and the hashes after it, so a
    // source somebody adds lands at the END of the directive — where a glob for
    // the two tokens side by side never looks.
    const run = await smoke(GOOD_CSP.replace("'sha256-Zm9vYmFyYmF6'", "'sha256-Zm9vYmFyYmF6' 'unsafe-inline'"))
    expect(verdict(run, NO_UNSAFE_INLINE)).toBe('fail')
    expect(run.code).toBe(1)
  })

  test('a prepended unsafe-inline is caught', async () => {
    const run = await smoke(GOOD_CSP.replace("script-src 'self'", "script-src 'unsafe-inline' 'self'"))
    expect(verdict(run, NO_UNSAFE_INLINE)).toBe('fail')
  })

  test('unsafe-inline in another directive is not a script finding', async () => {
    // style-src carries it in the real policy. Condemning that would make the
    // check red on every correct deployment, and a check that is always red is
    // a check nobody reads.
    expect(verdict(await smoke(GOOD_CSP), NO_UNSAFE_INLINE)).toBe('pass')
  })

  test('an installation serving no policy at all fails rather than passes', async () => {
    const run = await smoke(null)
    expect(verdict(run, NO_UNSAFE_INLINE)).toBe('fail')
    expect(run.out).toContain('there is no content-security-policy header at all')
  })

  test('a policy that names neither script-src nor default-src fails', async () => {
    // Nothing in it constrains a <script>, so there is no directive to find the
    // word unsafe-inline missing from.
    const run = await smoke("style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
    expect(verdict(run, NO_UNSAFE_INLINE)).toBe('fail')
  })

  test('with no script-src, default-src is what gets judged', async () => {
    // The browser falls back to default-src for scripts, so the check has to
    // as well — otherwise a policy can drop script-src, hand scripts an
    // unsafe-inline default-src, and be pronounced clean.
    const unsafe = await smoke("default-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
    expect(verdict(unsafe, NO_UNSAFE_INLINE)).toBe('fail')

    const clean = await smoke("default-src 'self'; frame-ancestors 'none'")
    expect(verdict(clean, NO_UNSAFE_INLINE)).toBe('pass')
    // Still not hash-based, and the script says so instead of implying the
    // inline theme block is admitted.
    expect(verdict(clean, BY_HASH)).toBe('fail')
  })

  test('a policy whose script-src lost its hash is reported as not hash-based', async () => {
    const run = await smoke(GOOD_CSP.replace(" 'sha256-Zm9vYmFyYmF6'", ''))
    expect(verdict(run, BY_HASH)).toBe('fail')
    expect(verdict(run, NO_UNSAFE_INLINE)).toBe('pass')
  })

  test('the version check stays quiet unless EXPECT_VERSION asks for it', async () => {
    // /ready naming its version is a check; agreeing with a release is only a
    // check when a release was named.
    const run = await smoke(GOOD_CSP)
    expect(run.out).toContain('/ready names its version (9.9.9)')
    expect(run.out).not.toContain('the served version is the released one')
  })
})
