// Compile-time embedded agent-hooks installer — the self-contained binary
// serves `curl -fsSL <host>/install.sh | sh` with no repo checkout beside it.
//
// Embedded-only (no disk-first read like docs-embedded.ts): installers are
// release artifacts, not live-edited docs, and the byte-identity drift test in
// install-embedded.test.ts keeps the embed honest against the source files.
// The hook scripts embed straight from examples/agent-hooks/ — the single
// source the documentation already points at.
import type { Config } from '../config.ts'
import installSh from './install/install.sh' with { type: 'text' }
import installPs1 from './install/install.ps1' with { type: 'text' }
import briefingSh from '../../examples/agent-hooks/wikikit-briefing.sh' with { type: 'text' }
import contextSh from '../../examples/agent-hooks/wikikit-context.sh' with { type: 'text' }
import captureSh from '../../examples/agent-hooks/wikikit-capture.sh' with { type: 'text' }
import briefingPs1 from '../../examples/agent-hooks/wikikit-briefing.ps1' with { type: 'text' }
import contextPs1 from '../../examples/agent-hooks/wikikit-context.ps1' with { type: 'text' }
import capturePs1 from '../../examples/agent-hooks/wikikit-capture.ps1' with { type: 'text' }

/** Servable hook scripts — keys are pinned to zInstallHookScriptParams. */
export const INSTALL_HOOK_SCRIPTS: Record<string, string> = {
  'wikikit-briefing.sh': briefingSh,
  'wikikit-context.sh': contextSh,
  'wikikit-capture.sh': captureSh,
  'wikikit-briefing.ps1': briefingPs1,
  'wikikit-context.ps1': contextPs1,
  'wikikit-capture.ps1': capturePs1,
}

const BASE_URL_PLACEHOLDER = '__WIKIKIT_BASE_URL__'

/**
 * The served installer with the placeholder resolved to this server's public
 * URL — same self-truth source as the MCP review_url (config.publicUrl).
 */
export function renderInstaller(config: Config, kind: 'sh' | 'ps1'): string {
  const source = kind === 'sh' ? installSh : installPs1
  return source.replaceAll(BASE_URL_PLACEHOLDER, config.publicUrl)
}
