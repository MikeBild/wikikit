// End-to-end run of the served install.sh against a scratch HOME and a local
// hook-script stub: merge-never-clobber into pre-existing harness configs,
// byte-identical re-run (idempotency), and --uninstall removing exactly the
// wikikit entries. Gated behind RUN_INTEGRATION=1 like the other integration
// suites; additionally skipped where bash/jq are unavailable.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INSTALL_HOOK_SCRIPTS } from '../../src/http/install-embedded.ts'

const hasCmd = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0
const integration = process.env.RUN_INTEGRATION === '1' && hasCmd('bash') && hasCmd('jq')
const it = integration ? test : test.skip

const INSTALLER = join(import.meta.dir, '../../src/http/install/install.sh')

let home: string
let server: ReturnType<typeof Bun.serve>
let baseUrl: string

const FOREIGN_ENTRY = {
  matcher: 'startup',
  hooks: [{ type: 'command', command: 'echo pre-existing-user-hook' }],
}

// Async on purpose: the hook-script stub (Bun.serve) lives in THIS process, so
// a synchronous spawn would block the event loop the stub needs to answer curl
// — a deadlock, not a slow test.
async function runInstaller(...args: string[]) {
  const proc = Bun.spawn(['sh', INSTALLER, ...args], {
    env: { ...process.env, HOME: home, WIKIKIT_API_KEY: '', WIKIKIT_URL: '', WIKIKIT_SPACE: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { status, stdout, stderr }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

beforeAll(() => {
  if (!integration) return
  home = mkdtempSync(join(tmpdir(), 'wikikit-install-'))
  // Pre-seed all three harnesses; Claude Code with an existing foreign hook
  // that the installer must preserve.
  mkdirSync(join(home, '.claude'))
  writeFileSync(
    join(home, '.claude/settings.json'),
    JSON.stringify({ model: 'opus', hooks: { SessionStart: [FOREIGN_ENTRY] } }, null, 2),
  )
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex/config.toml'), '[tui]\ntheme = "dark"\n')
  mkdirSync(join(home, '.cursor'))

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.replace('/install/hooks/', '')
      const script = INSTALL_HOOK_SCRIPTS[name]
      return script ? new Response(script) : new Response('not found', { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  if (!integration) return
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
})

describe('install.sh (integration)', () => {
  it('installs hooks, wires all three harnesses, preserves foreign entries', async () => {
    const result = await runInstaller('--yes', '--url', baseUrl, '--key', 'wk_itest-install', '--space', 'demo')
    expect(result.status, result.stderr).toBe(0)

    for (const name of ['wikikit-briefing.sh', 'wikikit-context.sh', 'wikikit-capture.sh']) {
      const path = join(home, '.wikikit/hooks', name)
      expect(readFileSync(path, 'utf8')).toBe(INSTALL_HOOK_SCRIPTS[name]!)
      expect(statSync(path).mode & 0o111, `${name} executable`).toBeGreaterThan(0)
    }

    const env = readFileSync(join(home, '.wikikit/env'), 'utf8')
    expect(env).toContain('export WIKIKIT_API_KEY="${WIKIKIT_API_KEY:-wk_itest-install}"')
    expect(env).toContain('export WIKIKIT_SPACE="${WIKIKIT_SPACE:-demo}"')
    expect(statSync(join(home, '.wikikit/env')).mode & 0o777).toBe(0o600)

    const claude = readJson(join(home, '.claude/settings.json')) as {
      model: string
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(claude.model).toBe('opus')
    expect(claude.hooks.SessionStart).toHaveLength(2)
    expect(claude.hooks.SessionStart![0]).toEqual(FOREIGN_ENTRY)
    expect(claude.hooks.SessionStart![1]!.hooks[0]!.command).toContain('/.wikikit/hooks/wikikit-briefing.sh')
    expect(claude.hooks.UserPromptSubmit![0]!.hooks[0]!.command).toContain('wikikit-context.sh')
    expect(claude.hooks.SessionEnd![0]!.hooks[0]!.command).toContain('wikikit-capture.sh')

    const codex = readJson(join(home, '.codex/hooks.json')) as { hooks: Record<string, unknown[]> }
    expect(Object.keys(codex.hooks).sort()).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit'])
    const toml = readFileSync(join(home, '.codex/config.toml'), 'utf8')
    expect(toml).toContain('theme = "dark"')
    expect(toml).toContain('[features]\nhooks = true')
    expect(toml).toContain('[mcp_servers.wikikit]')
    expect(toml).toContain(`url = "${baseUrl}/mcp"`)
    expect(toml).toContain('bearer_token_env_var = "WIKIKIT_API_KEY"')

    const cursor = readJson(join(home, '.cursor/hooks.json')) as {
      version: number
      hooks: Record<string, { command: string }[]>
    }
    expect(cursor.version).toBe(1)
    expect(cursor.hooks.sessionStart![0]!.command).toContain('wikikit-briefing.sh')
    expect(cursor.hooks.beforeSubmitPrompt![0]!.command).toContain('wikikit-context.sh')
    expect(cursor.hooks.stop![0]!.command).toContain('wikikit-capture.sh')
  })

  it('re-running leaves every config byte-identical (idempotency)', async () => {
    const configs = ['.claude/settings.json', '.codex/hooks.json', '.codex/config.toml', '.cursor/hooks.json']
    const before = configs.map((f) => readFileSync(join(home, f), 'utf8'))
    const result = await runInstaller('--yes', '--url', baseUrl, '--key', 'wk_itest-install', '--space', 'demo')
    expect(result.status, result.stderr).toBe(0)
    const after = configs.map((f) => readFileSync(join(home, f), 'utf8'))
    expect(after).toEqual(before)
  })

  it('hook scripts survive a chmod-and-execute smoke run (keyless → silent exit 0)', () => {
    const hook = join(home, '.wikikit/hooks/wikikit-context.sh')
    chmodSync(hook, 0o755)
    const result = spawnSync('bash', [hook], {
      encoding: 'utf8',
      input: JSON.stringify({ prompt: 'hello', cwd: home }),
      // No usable key on purpose: the contract is print nothing, exit 0.
      env: { ...process.env, HOME: join(home, 'nonexistent-subdir'), WIKIKIT_API_KEY: '' },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('--uninstall removes exactly the wikikit entries and the hooks dir', async () => {
    const result = await runInstaller('--uninstall')
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(home, '.wikikit/hooks'))).toBe(false)
    // The key-holding env file stays.
    expect(existsSync(join(home, '.wikikit/env'))).toBe(true)

    const claude = readJson(join(home, '.claude/settings.json')) as {
      model: string
      hooks: Record<string, unknown[]>
    }
    expect(claude.model).toBe('opus')
    expect(claude.hooks.SessionStart).toEqual([FOREIGN_ENTRY])
    expect(claude.hooks.UserPromptSubmit).toEqual([])
    expect(claude.hooks.SessionEnd).toEqual([])

    const codex = readJson(join(home, '.codex/hooks.json')) as { hooks: Record<string, unknown[]> }
    expect(Object.values(codex.hooks).flat()).toEqual([])
    const cursor = readJson(join(home, '.cursor/hooks.json')) as { hooks: Record<string, unknown[]> }
    expect(Object.values(cursor.hooks).flat()).toEqual([])
  })
})
