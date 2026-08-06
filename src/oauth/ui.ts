import { createHash } from 'node:crypto'

const AUTH_UI_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"

const TOKENS = `
  /*mcp-auth:begin*/
  :root{color-scheme:light dark;--background:#ffffff;--foreground:#020817;--card:#ffffff;--muted:#f1f5f9;--muted-foreground:#64748b;--primary:#0f172a;--primary-foreground:#f8fafc;--primary-hover:#020817;--border:#e2e8f0;--input:#e2e8f0;--destructive:#dc2626;--ring:#2563eb;--radius:12px;--radius-md:calc(var(--radius)*.8);--radius-lg:var(--radius);--radius-xl:calc(var(--radius)*1.4);--shadow:0 10px 30px rgba(2,8,23,.08)}
  @media(prefers-color-scheme:dark){:root:not(.scheme-light){color-scheme:dark;--background:#020817;--foreground:#f8fafc;--card:#0f172a;--muted:#1e293b;--muted-foreground:#94a3b8;--primary:#f8fafc;--primary-foreground:#0f172a;--primary-hover:#ffffff;--border:#334155;--input:#334155;--destructive:#f87171;--ring:#60a5fa;--shadow:0 10px 30px rgba(0,0,0,.5)}}
  :root.scheme-light{color-scheme:light}:root.scheme-dark{color-scheme:dark;--background:#020817;--foreground:#f8fafc;--card:#0f172a;--muted:#1e293b;--muted-foreground:#94a3b8;--primary:#f8fafc;--primary-foreground:#0f172a;--primary-hover:#ffffff;--border:#334155;--input:#334155;--destructive:#f87171;--ring:#60a5fa;--shadow:0 10px 30px rgba(0,0,0,.5)}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;padding:24px;display:flex;align-items:center;justify-content:center;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--background);color:var(--foreground)}
  :focus-visible{outline:2px solid var(--ring);outline-offset:2px}
  .card{background:var(--card);width:100%;max-width:420px;border:1px solid var(--border);border-radius:var(--radius-xl);box-shadow:var(--shadow);padding:32px}
  .brand{display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:var(--radius-lg);background:var(--primary);color:var(--primary-foreground);font-weight:700;font-size:18px;letter-spacing:-.03em;margin:0 0 20px}
  h1{font-size:1.2rem;line-height:1.3;margin:0 0 8px}p{margin:0 0 10px;line-height:1.5}.muted{color:var(--muted-foreground);font-size:.9rem}.strong{font-weight:600}.error{color:var(--destructive)}
  ul.scopes{list-style:none;margin:18px 0 4px;padding:0}ul.scopes li{padding:12px 14px;margin-bottom:8px;background:var(--muted);border:1px solid var(--border);border-radius:var(--radius-md)}.provider-stack{display:grid;gap:10px;margin-top:20px}
  .scope-row{display:flex;align-items:flex-start;gap:10px;cursor:pointer}.scope-row input[type=checkbox]{margin-top:2px;flex:none;accent-color:var(--primary)}.scope-text{display:flex;flex-direction:column;gap:2px}.scope-name{font-weight:600;font-size:.92rem}.scope-desc{color:var(--muted-foreground);font-size:.85rem}
  label.field{display:block;margin:16px 0 0;font-size:.9rem;font-weight:600}input[type=password]{width:100%;margin-top:6px;padding:11px 12px;border:1px solid var(--input);border-radius:var(--radius-md);background:var(--card);color:var(--foreground);font:inherit}
  .actions{display:flex;gap:10px;margin-top:22px}button,.button{flex:1;min-height:44px;padding:11px 18px;display:flex;align-items:center;justify-content:center;font-size:.95rem;font-weight:600;cursor:pointer;border-radius:var(--radius-md);border:1px solid transparent;font-family:inherit;text-align:center;text-decoration:none}.provider-stack .button{width:100%}.approve{background:var(--primary);color:var(--primary-foreground)}.approve:hover{background:var(--primary-hover)}.deny{background:var(--card);color:var(--foreground);border-color:var(--input)}.deny:hover{background:var(--muted)}
  .switch{display:block;margin:16px auto 0;padding:0;border:0;background:transparent;color:var(--muted-foreground);font-size:.82rem;text-decoration:underline;cursor:pointer}.footer{margin-top:20px;color:var(--muted-foreground);font-size:.78rem;text-align:center}@media(max-width:480px){body{padding:12px}.card{padding:24px}.actions{flex-direction:column-reverse}}
  /*mcp-auth:end*/
`

/**
 * The contract marker, derived from the bytes it describes.
 *
 * It used to be a hand-typed `content="2"`, in four repositories. Four products
 * can all claim version 2 while their CSS quietly diverges — a marker that could
 * not be wrong because it said nothing about the bytes. This one is computed from
 * TOKENS, so two products serving different CSS announce different strings, in
 * the DOM, in every screenshot. There is no version to keep in step because there
 * is no version: the bytes are the identity.
 */
export const AUTH_UI_DIGEST = `sha256-${createHash('sha256').update(sharedRegion(TOKENS)).digest('hex').slice(0, 12)}`

/** The bytes between the sentinels — what the family shares, not what this file contains. */
function sharedRegion(css: string): string {
  return css.match(/\/\*mcp-auth:begin\*\/([\s\S]*?)\/\*mcp-auth:end\*\//)?.[1] ?? ''
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!,
  )
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="mcp-auth-ui-contract" content="${AUTH_UI_DIGEST}"><title>${escapeHtml(title)} — WikiKit</title><style>${TOKENS}</style></head><body><main class="card" data-auth-contract="mcp-auth"><div class="brand" aria-label="WikiKit">W</div>${body}<div class="footer">WikiKit MCP · OAuth 2.1</div></main></body></html>`
}

const SCOPE_LABELS: Record<string, [string, string]> = {
  'knowledge:read': ['Read', 'Read reviewed concepts, claims, sources and decisions'],
  'knowledge:propose': ['Propose', 'Submit knowledge changes for human review'],
  'knowledge:review': ['Review', 'Inspect and start review of pending proposals'],
  'knowledge:approve': ['Approve', 'Approve or reject reviewed proposals'],
  offline_access: ['Offline access', 'Keep the connector signed in with rotating refresh tokens'],
}

export function renderConsentPage(options: {
  clientName: string
  identityLabel: string
  targetLabel: string
  offeredScopes: string[]
  csrfToken: string
  loginState: string
  error?: string
}): string {
  const items = options.offeredScopes
    .map((scope) => {
      const [name, description] = SCOPE_LABELS[scope] ?? [scope, scope]
      const baseline = scope === 'knowledge:read'
      return `<li><label class="scope-row"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked${baseline ? ' disabled' : ''}><span class="scope-text"><span class="scope-name">${escapeHtml(name)} · ${escapeHtml(scope)}</span><span class="scope-desc">${escapeHtml(description)}</span></span></label>${baseline ? `<input type="hidden" name="scope" value="${escapeHtml(scope)}">` : ''}</li>`
    })
    .join('')
  return shell(
    'Authorize access',
    `<h1>Authorize access</h1><p><span class="strong">${escapeHtml(options.clientName)}</span> is requesting access to <span class="strong">${escapeHtml(options.targetLabel)}</span>.</p><p class="muted">Signed in as ${escapeHtml(options.identityLabel)}</p><p class="muted">It will be able to:</p>${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ''}<form method="POST" action="/v1/oauth/authorize/decision"><ul class="scopes">${items}</ul><input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}"><input type="hidden" name="login_state" value="${escapeHtml(options.loginState)}"><div class="actions"><button type="submit" name="decision" value="deny" class="deny">Deny</button><button type="submit" name="decision" value="approve" class="approve">Approve</button></div><button type="submit" name="decision" value="switch_account" class="switch">Use another account</button></form>`,
  )
}

export function renderProviderChoice(options: {
  state: string
  providers: Array<{ id: string; protocol: 'api_key' | 'oidc'; label: string }>
}): string {
  const providers = options.providers
    .map((provider) => {
      const href = `/v1/identity/login/start?login_state=${encodeURIComponent(options.state)}&provider=${encodeURIComponent(provider.id)}`
      const label = provider.protocol === 'api_key' ? 'Continue with API key' : 'Continue with SSO'
      return `<a class="button approve" href="${href}">${label}</a>`
    })
    .join('')
  return shell(
    'Sign in',
    `<h1>Sign in to WikiKit</h1><p class="muted">Choose how to authenticate this authorization request.</p><div class="provider-stack">${providers}</div>`,
  )
}

export function renderApiKeyLogin(options: { state: string; providerId: string; error?: string }): string {
  return shell(
    'Sign in',
    `<h1>Sign in to WikiKit</h1><p class="muted">Use a scoped WikiKit API key to authorize this MCP client.</p>${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ''}<form method="POST" action="/v1/identity/login/start"><input type="hidden" name="provider" value="${escapeHtml(options.providerId)}"><input type="hidden" name="login_state" value="${escapeHtml(options.state)}"><label class="field">API key<input type="password" name="api_key" autocomplete="current-password" required></label><div class="actions"><button class="approve" type="submit">Continue</button></div></form>`,
  )
}

export function renderErrorPage(options: { message: string; retryHref?: string }): string {
  // Browser-funnel failures render in the same page()/TOKENS shell as every
  // other auth screen. When a retry target is known, "Sign in again" either
  // re-enters the login funnel or carries the RFC 6749 access_denied redirect
  // back to the waiting OAuth client so MCP connectors never hang.
  return shell(
    'Sign-in failed',
    `<h1>Sign-in failed</h1><p>${escapeHtml(options.message)}</p>${
      options.retryHref
        ? `<div class="actions"><a class="button approve" href="${escapeHtml(options.retryHref)}">Sign in again</a></div>`
        : ''
    }`,
  )
}

export function authHtmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private,no-store',
      'content-security-policy': AUTH_UI_CSP,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  })
}
