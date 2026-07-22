import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { authHtmlResponse, renderConsentPage, renderProviderChoice } from '../../src/oauth/ui.ts'

const COMMON_STYLE_SHA256 = '61333cf68d1c955484e7c8fd1e5b68ad9ff4caf9e99799493f868bd19dcb9e64'

describe('common MCP auth UI contract', () => {
  test('is branded, script-free, escaped and request-bounded', () => {
    const html = renderConsentPage({
      clientName: '<script>bad</script>',
      identityLabel: 'operator@example.com',
      targetLabel: 'WikiKit',
      offeredScopes: ['knowledge:read'],
      csrfToken: 'csrf',
      loginState: 'state',
    })
    expect(html).toContain('data-auth-contract="mcp-auth-v2"')
    expect(html).toContain('name="mcp-auth-ui-contract" content="2"')
    expect(html).toContain('max-width:420px')
    expect(html).toContain('value="knowledge:read" checked disabled')
    expect(html).toContain('value="switch_account"')
    expect(html).not.toContain('<script>bad</script>')
    expect(html).not.toContain('knowledge:approve')
    const response = authHtmlResponse(html)
    expect(response.headers.get('cache-control')).toBe('private,no-store')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  test('provider chooser exposes the canonical SSO-first CTA contract', () => {
    const html = renderProviderChoice({
      state: 'state',
      providers: [
        { id: 'api-key', protocol: 'api_key', label: 'WikiKit API key' },
        { id: 'google', protocol: 'token_bridge', label: 'Google' },
        { id: 'entra', protocol: 'oidc', label: 'Microsoft Entra ID' },
      ],
    })
    expect(html.match(/Continue with SSO/g)).toHaveLength(2)
    expect(html.match(/Continue with API key/g)).toHaveLength(1)
    expect(html).not.toContain('Continue with Continue with')
    expect(html).not.toContain('Microsoft Entra ID')
    expect(html).toContain('class="provider-stack"')
    const styles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
    expect(createHash('sha256').update(styles).digest('hex')).toBe(COMMON_STYLE_SHA256)
  })
})
