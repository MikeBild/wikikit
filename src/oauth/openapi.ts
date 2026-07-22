// Public MCP-auth contract shared by the product family. The implementation
// stays product-local; only protocol, routes, schemas and browser states match.
type Paths = Record<string, Record<string, unknown>>
type Schemas = Record<string, unknown>

const json = (schema: unknown) => ({ 'application/json': { schema } })
const html = { 'text/html': { schema: { type: 'string' } } }
const empty = { 204: { description: 'Completed' } }
const errorResponses = {
  400: { description: 'Invalid request', content: json({ $ref: '#/components/schemas/OAuthError' }) },
  401: { description: 'Identity assertion rejected', content: json({ $ref: '#/components/schemas/OAuthError' }) },
  403: {
    description: 'Identity or requested access denied',
    content: json({ $ref: '#/components/schemas/OAuthError' }),
  },
}
const formBody = {
  required: true,
  content: {
    'application/x-www-form-urlencoded': { schema: { type: 'object', additionalProperties: { type: 'string' } } },
  },
}

export const MCP_AUTH_OPERATIONS = [
  'get /.well-known/oauth-protected-resource',
  'get /.well-known/oauth-protected-resource/mcp',
  'get /.well-known/oauth-authorization-server',
  'post /v1/oauth/register',
  'get /v1/oauth/authorize',
  'post /v1/oauth/authorize/decision',
  'post /v1/oauth/token',
  'post /v1/oauth/revoke',
  'get /v1/identity/providers',
  'post /v1/identity/sessions',
  'get /v1/identity/login/start',
  'post /v1/identity/login/start',
  'get /v1/identity/login/callback',
  'post /v1/identity/logout',
] as const

export function registerMcpAuthOpenApi(paths: Paths, schemas: Schemas): void {
  Object.assign(schemas, {
    AuthProvider: {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'id', 'label'],
      properties: {
        protocol: { type: 'string', enum: ['api_key', 'oidc'] },
        id: { type: 'string' },
        label: { type: 'string', enum: ['SSO', 'API key'] },
        issuer: { type: 'string', format: 'uri' },
      },
    },
    ProvidersResponse: {
      type: 'object',
      additionalProperties: false,
      required: ['providers'],
      properties: { providers: { type: 'array', items: { $ref: '#/components/schemas/AuthProvider' } } },
    },
    IdentitySessionRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['provider_id', 'identity_token'],
      properties: {
        provider_id: { type: 'string', minLength: 1 },
        identity_token: { type: 'string', minLength: 1 },
      },
    },
    IdentitySessionResponse: {
      type: 'object',
      additionalProperties: false,
      required: ['api_key', 'principal_id', 'context_id', 'email'],
      properties: {
        api_key: { type: 'string' },
        principal_id: { type: 'string' },
        context_id: { type: ['string', 'null'] },
        email: { type: 'string' },
      },
    },
    OAuthError: {
      type: 'object',
      additionalProperties: true,
      properties: { error: { type: 'string' }, error_description: { type: 'string' }, code: { type: 'string' } },
    },
  })

  const discovery = (operationId: string, summary: string) => ({
    get: {
      operationId,
      tags: ['MCP authentication'],
      summary,
      responses: { 200: { description: 'Metadata', content: json({ type: 'object' }) } },
    },
  })
  paths['/.well-known/oauth-protected-resource'] = discovery(
    'getOAuthProtectedResource',
    'Read MCP protected-resource metadata',
  )
  paths['/.well-known/oauth-protected-resource/mcp'] = discovery(
    'getMcpOAuthProtectedResource',
    'Read MCP protected-resource metadata',
  )
  paths['/.well-known/oauth-authorization-server'] = discovery(
    'getOAuthAuthorizationServer',
    'Read OAuth authorization-server metadata',
  )
  paths['/v1/oauth/register'] = {
    post: {
      operationId: 'registerOAuthClient',
      tags: ['MCP authentication'],
      summary: 'Register a public OAuth client',
      requestBody: {
        required: true,
        content: json({
          type: 'object',
          required: ['redirect_uris'],
          properties: {
            redirect_uris: { type: 'array', items: { type: 'string', format: 'uri' } },
            client_name: { type: 'string' },
          },
        }),
      },
      responses: { 201: { description: 'Client registered', content: json({ type: 'object' }) }, ...errorResponses },
    },
  }
  paths['/v1/oauth/authorize'] = {
    get: {
      operationId: 'authorizeOAuthClient',
      tags: ['MCP authentication'],
      summary: 'Start authorization-code login and consent',
      responses: {
        200: { description: 'Login or consent HTML', content: html },
        302: { description: 'Redirect' },
        ...errorResponses,
      },
    },
  }
  paths['/v1/oauth/authorize/decision'] = {
    post: {
      operationId: 'decideOAuthConsent',
      tags: ['MCP authentication'],
      summary: 'Approve or deny consent',
      requestBody: formBody,
      responses: { 302: { description: 'OAuth redirect' }, ...errorResponses },
    },
  }
  paths['/v1/oauth/token'] = {
    post: {
      operationId: 'exchangeOAuthToken',
      tags: ['MCP authentication'],
      summary: 'Exchange or refresh OAuth tokens',
      requestBody: formBody,
      responses: { 200: { description: 'Tokens', content: json({ type: 'object' }) }, ...errorResponses },
    },
  }
  paths['/v1/oauth/revoke'] = {
    post: {
      operationId: 'revokeOAuthToken',
      tags: ['MCP authentication'],
      summary: 'Revoke an OAuth token family',
      requestBody: formBody,
      responses: { 200: { description: 'Revoked' }, ...errorResponses },
    },
  }
  paths['/v1/identity/providers'] = {
    get: {
      operationId: 'listIdentityProviders',
      tags: ['MCP authentication'],
      summary: 'List available MCP authentication methods',
      responses: {
        200: {
          description: 'Canonical SSO-first method matrix',
          content: json({ $ref: '#/components/schemas/ProvidersResponse' }),
        },
      },
    },
  }
  paths['/v1/identity/sessions'] = {
    post: {
      operationId: 'createIdentitySession',
      tags: ['MCP authentication'],
      summary: 'Exchange a configured identity assertion for a scoped API key',
      requestBody: { required: true, content: json({ $ref: '#/components/schemas/IdentitySessionRequest' }) },
      responses: {
        200: {
          description: 'Scoped product session',
          content: json({ $ref: '#/components/schemas/IdentitySessionResponse' }),
        },
        ...errorResponses,
      },
    },
  }
  paths['/v1/identity/login/start'] = {
    get: {
      operationId: 'startIdentityLogin',
      tags: ['MCP authentication'],
      summary: 'Show the SSO-first login chooser or start a selected method',
      responses: {
        200: { description: 'Login HTML', content: html },
        302: { description: 'Provider redirect' },
        ...errorResponses,
      },
    },
    post: {
      operationId: 'submitApiKeyLogin',
      tags: ['MCP authentication'],
      summary: 'Authenticate the API-key login method',
      requestBody: formBody,
      responses: { 200: { description: 'Consent HTML', content: html }, ...errorResponses },
    },
  }
  paths['/v1/identity/login/callback'] = {
    get: {
      operationId: 'completeOidcLogin',
      tags: ['MCP authentication'],
      summary: 'Complete an OIDC login adapter',
      responses: {
        200: { description: 'Consent HTML', content: html },
        302: { description: 'Redirect' },
        ...errorResponses,
      },
    },
  }
  paths['/v1/identity/logout'] = {
    post: {
      operationId: 'logoutIdentitySession',
      tags: ['MCP authentication'],
      summary: 'Revoke the browser operator session',
      responses: { ...empty, 200: { description: 'Logged out' } },
    },
  }
}
