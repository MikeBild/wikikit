import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  authHtmlResponse,
  renderApiKeyLogin,
  renderConsentPage,
  renderErrorPage,
  renderProviderChoice,
  withScheme,
} from '../../src/oauth/ui.ts'

const COMMON_STYLE_SHA256 = 'ebdaece15b70206254f6430990bd14abfbc51a62d319cda6383bc8163b10b4d3'

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
    expect(html).toContain('data-auth-contract="mcp-auth"')
    expect(html).toContain('name="mcp-auth-ui-contract" content="sha256-ebdaece15b70"')
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
        { id: 'workforce', protocol: 'oidc', label: 'Workforce OIDC' },
      ],
    })
    expect(html.match(/Continue with SSO/g)).toHaveLength(1)
    expect(html.match(/Continue with API key/g)).toHaveLength(1)
    expect(html).not.toContain('Continue with Continue with')
    expect(html).not.toContain('Workforce OIDC')
    expect(html).toContain('class="provider-stack"')
    const styles = html.match(/\/\*mcp-auth:begin\*\/([\s\S]*?)\/\*mcp-auth:end\*\//)?.[1] ?? ''
    expect(createHash('sha256').update(styles).digest('hex')).toBe(COMMON_STYLE_SHA256)
  })

  test('the funnel declares both schemes, in the contract palette', () => {
    // The funnel was `color-scheme:light` and nothing else, so an operator
    // working in dark met a white page. The media query answers the case where
    // nobody has expressed a preference; since the cockpit landed there IS an
    // explicit one to honour, and `withScheme` sets the .scheme-* classes the
    // block has always carried — from a cookie, because these pages are
    // script-free by contract and cannot read a preference themselves.
    const html = renderProviderChoice({ state: 'state', providers: [] })
    expect(html).toContain('color-scheme:light dark')
    expect(html).toContain('@media(prefers-color-scheme:dark)')
    expect(html).toContain('--background:#ffffff;--foreground:#020817')
    expect(html).toContain('--background:#020817;--foreground:#f8fafc')
    expect(html).not.toContain('--ink:')
  })

  test('the funnel says what it is for — an authorization, or the cockpit', () => {
    // The same three screens serve two arrivals. "Choose how to authenticate
    // this authorization request" is accurate for an MCP client and baffling
    // for an operator opening their own console, and a sign-in page describing
    // something the reader is not doing teaches them to stop reading sign-in
    // pages. Caught by walking the funnel in a browser, not by a test.
    const oauth = renderProviderChoice({ state: 'state', providers: [] })
    expect(oauth).toContain('authorization request')

    const cockpit = renderProviderChoice({ state: 'state', providers: [], purpose: 'cockpit' })
    expect(cockpit).toContain('cockpit')
    expect(cockpit).not.toContain('authorization request')

    const keyForm = renderApiKeyLogin({ state: 'state', providerId: 'api-key', purpose: 'cockpit' })
    expect(keyForm).not.toContain('MCP client')
  })

  test('sign-in failure page stays in the shared shell and escapes everything', () => {
    const html = renderErrorPage({
      message: 'Your account is not authorized for WikiKit. Contact the operator.',
      retryHref: 'https://client.example/cb?error=access_denied&state=<x>',
    })
    expect(html).toContain('<h1>Sign-in failed</h1>')
    expect(html).toContain('<title>Sign-in failed — WikiKit</title>')
    expect(html).toContain('data-auth-contract="mcp-auth"')
    expect(html).toContain('name="mcp-auth-ui-contract" content="sha256-ebdaece15b70"')
    expect(html).toContain('Your account is not authorized for WikiKit. Contact the operator.')
    expect(html).toContain('>Sign in again</a>')
    expect(html).toContain('href="https://client.example/cb?error=access_denied&amp;state=&lt;x&gt;"')
    const styles = html.match(/\/\*mcp-auth:begin\*\/([\s\S]*?)\/\*mcp-auth:end\*\//)?.[1] ?? ''
    expect(createHash('sha256').update(styles).digest('hex')).toBe(COMMON_STYLE_SHA256)
  })

  test('sign-in failure page omits the retry action when no safe target is known', () => {
    const html = renderErrorPage({ message: 'This sign-in attempt expired or was already used. Please sign in again.' })
    expect(html).toContain('<h1>Sign-in failed</h1>')
    expect(html).not.toContain('Sign in again')
  })

  test('an explicit scheme is stamped OUTSIDE the pinned block', () => {
    // The .scheme-* classes live inside the contract bytes; setting one must
    // happen on the document element, or the digest above changes and this
    // funnel stops claiming the contract it implements.
    const html = renderProviderChoice({ state: 'state', providers: [] })
    const dark = withScheme(html, 'dark')
    expect(dark).toContain('<html lang="en" class="scheme-dark">')

    const styles = dark.match(/\/\*mcp-auth:begin\*\/([\s\S]*?)\/\*mcp-auth:end\*\//)?.[1] ?? ''
    expect(createHash('sha256').update(styles).digest('hex')).toBe(COMMON_STYLE_SHA256)
  })

  test('no scheme leaves the document exactly as rendered', () => {
    // Absence means "follow the OS", which the media query already does.
    const html = renderProviderChoice({ state: 'state', providers: [] })
    expect(withScheme(html, null)).toBe(html)
  })
})
