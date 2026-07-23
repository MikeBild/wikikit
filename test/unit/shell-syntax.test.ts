// Cheap, dependency-free syntax gates for every served shell script: `bash -n`
// for the hook examples, plus `sh -n` for the installer — install.sh is
// advertised as `curl | sh` and /bin/sh is dash/ash on Debian/Alpine, so it
// must parse under a strict POSIX shell, not just bash.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')

const SH_FILES = [
  'examples/agent-hooks/wikikit-briefing.sh',
  'examples/agent-hooks/wikikit-context.sh',
  'examples/agent-hooks/wikikit-capture.sh',
  'src/http/install/install.sh',
]

function hasCmd(cmd: string): boolean {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0
}

describe('shell syntax', () => {
  test.skipIf(!hasCmd('bash'))('bash -n parses every served .sh', () => {
    for (const file of SH_FILES) {
      const result = spawnSync('bash', ['-n', join(ROOT, file)], { encoding: 'utf8' })
      expect(result.status, `${file}: ${result.stderr}`).toBe(0)
    }
  })

  test.skipIf(!hasCmd('sh'))('sh -n parses the POSIX installer', () => {
    const result = spawnSync('sh', ['-n', join(ROOT, 'src/http/install/install.sh')], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  })
})
