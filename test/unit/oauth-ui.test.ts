import { describe, expect, test } from 'bun:test'
import { authHtmlResponse, renderConsentPage, renderProviderChoice } from '../../src/oauth/ui.ts'

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
    expect(html).toContain('data-auth-contract="mcp-auth-v1"')
    expect(html).toContain('name="mcp-auth-ui-contract" content="1"')
    expect(html).toContain('max-width:420px')
    expect(html).toContain('value="knowledge:read" checked disabled')
    expect(html).toContain('value="switch_account"')
    expect(html).not.toContain('<script>bad</script>')
    expect(html).not.toContain('knowledge:approve')
    const response = authHtmlResponse(html)
    expect(response.headers.get('cache-control')).toBe('private,no-store')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  test('provider chooser supports independent methods', () => {
    const html = renderProviderChoice({
      state: 'state',
      providers: [
        { id: 'api_key', label: 'WikiKit API key' },
        { id: 'firebase', label: 'Google' },
        { id: 'entra', label: 'Microsoft Entra ID' },
      ],
    })
    expect(html).toContain('WikiKit API key')
    expect(html).toContain('Google')
    expect(html).toContain('Microsoft Entra ID')
  })
})
