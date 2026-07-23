// Self-containment + drift guards for the agent hooks installer: the compiled
// binary must serve real, current scripts (same principle as docs-embedded),
// the servable-script enum must match the embedded assets, and the hook
// scripts must keep their never-break-a-session discipline.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INSTALL_HOOK_SCRIPTS, renderInstaller } from '../../src/http/install-embedded.ts'
import { zInstallHookScriptParams } from '../../src/http/schemas.ts'
import type { Config } from '../../src/config.ts'

const ROOT = join(import.meta.dir, '../..')
const PLACEHOLDER = '__WIKIKIT_BASE_URL__'
const config = { publicUrl: 'https://kb.example.test' } as Config

// Exit 2 means "block this event" in every harness — it must never appear as
// code (the comments explaining exactly that are fine).
function codeLines(script: string): string {
  return script
    .split('\n')
    .map((line) => line.split('#')[0]!)
    .join('\n')
}

describe('embedded installer (binary self-containment)', () => {
  test('hook scripts are embedded byte-identical to examples/agent-hooks (cannot drift)', () => {
    for (const name of Object.keys(INSTALL_HOOK_SCRIPTS)) {
      const onDisk = readFileSync(join(ROOT, 'examples/agent-hooks', name), 'utf8')
      expect(INSTALL_HOOK_SCRIPTS[name], name).toBe(onDisk)
    }
  })

  test('servable-script enum ↔ embedded assets (route cannot drift from embed)', () => {
    const enumValues = zInstallHookScriptParams.shape.script.options.map(String)
    expect(enumValues.sort()).toEqual(Object.keys(INSTALL_HOOK_SCRIPTS).sort())
  })

  test('installer sources are embedded byte-identical to src/http/install', () => {
    for (const [kind, file] of [
      ['sh', 'install.sh'],
      ['ps1', 'install.ps1'],
    ] as const) {
      const onDisk = readFileSync(join(ROOT, 'src/http/install', file), 'utf8')
      expect(renderInstaller({ publicUrl: PLACEHOLDER } as Config, kind), file).toBe(onDisk)
    }
  })

  test('rendered installers carry publicUrl and no leftover placeholder', () => {
    for (const kind of ['sh', 'ps1'] as const) {
      const rendered = renderInstaller(config, kind)
      expect(rendered, kind).toContain('https://kb.example.test')
      expect(rendered, kind).not.toContain(PLACEHOLDER)
      expect(rendered.length, kind).toBeGreaterThan(1000)
    }
  })

  test('sh hooks keep the lifecycle contract: bash shebang, env sourcing, exit-0 discipline', () => {
    for (const name of ['wikikit-briefing.sh', 'wikikit-context.sh', 'wikikit-capture.sh']) {
      const script = INSTALL_HOOK_SCRIPTS[name]!
      expect(script.startsWith('#!/usr/bin/env bash'), name).toBe(true)
      expect(script, name).toContain('$HOME/.wikikit/env')
      expect(script, name).toContain('exit 0')
      expect(codeLines(script), name).not.toContain('exit 2')
    }
  })

  test('ps1 hooks keep the lifecycle contract: env sourcing, unconditional exit 0 last', () => {
    for (const name of ['wikikit-briefing.ps1', 'wikikit-context.ps1', 'wikikit-capture.ps1']) {
      const script = INSTALL_HOOK_SCRIPTS[name]!
      expect(script, name).toContain(".wikikit\\env.ps1'")
      expect(script.trimEnd().endsWith('exit 0'), name).toBe(true)
      expect(codeLines(script), name).not.toContain('exit 2')
    }
  })

  test('installer guards: main-function guard (sh) and TLS 1.2 (ps1)', () => {
    const sh = renderInstaller(config, 'sh')
    // rustup-style: a truncated `curl | sh` download defines functions but runs nothing.
    expect(sh.trimEnd().endsWith('main "$@" || exit 1')).toBe(true)
    const ps1 = renderInstaller(config, 'ps1')
    expect(ps1).toContain('SecurityProtocolType]::Tls12')
    expect(ps1).toContain('-Depth 32')
  })
})
