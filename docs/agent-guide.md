# WikiKit agent guide

This file is WikiKit's built-in system knowledge for AI agents. It is shipped
inside the server binary, versioned with the code, and available without a
database row or a review step. It explains the product and the integration;
ordinary WikiKit spaces contain the user's reviewed knowledge.

An agent can read the same guide in three ways:

- MCP tool: `wikikit_guide`, including in tools-only clients.
- MCP resource: `wikikit://system/agent-guide`.
- Public HTTP: `GET /agent-guide.md`.

The shorter discovery files are at `/llms.txt` and
`/.well-known/llms.txt`; the complete reference is at `/llms-full.txt` and
`/.well-known/llms-full.txt`.

## What WikiKit is

WikiKit is a headless, AI-native knowledge system. Sources are archived
verbatim, an LLM turns them into maintained concept pages with grounded claims
and citations, and every change remains a proposal until a human approves it.

Keep these boundaries clear:

- Reading tools return approved knowledge and provenance.
- Ingest and proposal tools stage changes; they do not make knowledge live.
- Approval is a separate, explicit human decision. For MCP review, call
  `wikikit_review_proposal` with only the proposal id; WikiKit itself asks the
  human for approve/reject and an optional note. Never invent, pre-fill or
  infer that decision.
- If reviewed knowledge does not answer a question, say that the knowledge is
  missing instead of filling the gap from memory.

## Zero-configuration agent workflow

After one MCP connection has been added, no copied mega-prompt, fixed list of
spaces, or repository manifest is required:

1. WikiKit's MCP `initialize` response supplies a compact operating contract.
2. If a lifecycle hook has not already injected context, call
   `wikikit_context` with the current user task and, when known, the repository
   name as `project_hint`.
3. WikiKit selects relevant spaces from stable space-purpose metadata and
   returns a small briefing. It does not scan incidental facts inside concept
   pages as routing triggers.
4. Use `wikikit_search` and `wikikit_read` for full knowledge only when the task
   needs it. Use provenance and history tools when the origin matters.

There is no primary/secondary-space ceiling. Any visible spaces can be active
together. An explicit `manual_spaces` list always wins over automatic routing.
For clients or hooks that accept natural prompt conventions, users may write
`space: one+two`, `spaces: one,two`, or `wikikit: one+two`.

Lifecycle hooks are optional. `SessionStart` should load only a compact
briefing. `UserPromptSubmit` should select task-specific additional spaces.
Do not load every visible space at startup.

## Connect without a WikiKit CLI

WikiKit has no CLI requirement. Its MCP endpoint is the canonical integration:

```text
https://YOUR-WIKIKIT-HOST/mcp
```

For a remote deployment, OAuth is the lowest-setup option: add the URL, choose
OAuth or **Authenticate** in the client, and complete the browser login. For a
local or non-interactive deployment, use a narrowly scoped WikiKit API key in
an environment variable. A routine knowledge client normally needs
`knowledge:read`; add `knowledge:propose` only when it should ingest or stage
changes. Do not give routine agents `knowledge:approve` or `admin`.

### Clients with an MCP settings screen

Choose **Streamable HTTP**, enter the `/mcp` URL, save, and restart or reconnect
if requested. Select **Authenticate** for OAuth. This is the preferred path
because it does not require editing files or running a WikiKit-specific command.

### TOML-based MCP clients

Use the client's global or trusted-project configuration:

```toml
[mcp_servers.wikikit]
url = "https://YOUR-WIKIKIT-HOST/mcp"
bearer_token_env_var = "WIKIKIT_API_KEY"
```

Omit `bearer_token_env_var` when using OAuth and authenticate through the
client's MCP management screen.

### JSON-based MCP clients

Use the client's user or project MCP configuration:

```json
{
  "mcpServers": {
    "wikikit": {
      "type": "http",
      "url": "https://YOUR-WIKIKIT-HOST/mcp",
      "headers": {
        "Authorization": "Bearer ${WIKIKIT_API_KEY}"
      }
    }
  }
}
```

For OAuth, remove `headers` and complete authentication in the client. A
project-scoped configuration may require a one-time workspace trust decision.

### Hosted or repository agents

Open the repository or workspace's MCP-server settings and add an HTTP server.
If the platform does not support remote MCP OAuth, store a read key in its
secret store and substitute it into the `Authorization` header. If the platform
supports tools but not MCP resources, enable `wikikit_guide` together with
`wikikit_spaces`, `wikikit_context`, `wikikit_search`, and `wikikit_read`.
Never commit the token.

### Other MCP clients

Choose Streamable HTTP, use the `/mcp` URL, and prefer OAuth when the client
supports protected-resource discovery and PKCE. Otherwise send either
`Authorization: Bearer wk_...` or `X-API-Key: wk_...`. A client that supports
MCP resources should read `wikikit://system/agent-guide`; a tools-only client
should call `wikikit_guide` once when it needs the operating model.

## Interactive human review over MCP

Before review, use `wikikit_proposals` with `proposal_id` to inspect the full
structured diff. Then call `wikikit_review_proposal` with that id only. WikiKit
opens a native MCP form in which the human owns `decision` and optional `note`.
Accept applies the review atomically; decline, cancel, timeout, invalid data or
missing form support leaves the proposal pending. A successful audit record
uses `review_channel: "mcp_elicitation"`.

The reviewing identity needs `knowledge:approve`, but scope alone is not a
human decision. Keep routine autonomous-agent credentials read/propose-only.
For Codex, route MCP elicitations to the user:

```toml
approval_policy = { granular = { mcp_elicitations = true } }
approvals_reviewer = "user"
```

Claude Code must be 2.1.76 or newer. ChatGPT connectors are supported only
when the active connector advertises native form elicitation; reconnect after
upgrades and test the capability. WikiKit fails closed when it is absent. In
that case, a trusted human can inspect the same diff and use the REST
approve/reject endpoint; REST reviews record `review_channel: "rest"`.

## Space design and routing

Create separate spaces for knowledge with a distinct purpose, audience,
authority, lifecycle, or access boundary. Do not create a new space merely for
one temporary task. A space's stable routing metadata belongs in
`settings.agent_context`:

```json
{
  "description": "What this space is authoritative for",
  "agent_context": {
    "aliases": ["names users naturally say"],
    "keywords": ["durable task or domain terms"]
  },
  "agent_briefing": {
    "pinned_concepts": ["small-orientation-page"]
  }
}
```

Good selectors describe the durable purpose of the space. Temporary dates,
one-off campaigns, filenames, or facts mentioned in a page are poor selectors.
For example, an authoring space can describe a person's voice, house style,
article structure, research, publication, and maintenance. A rare task such as
backdating an article is knowledge inside that space, not the space's general
activation rule.

## First user space

A zero-config local start creates the mutable `default` space. Production
operators can create and configure spaces through the REST API or any HTTP UI;
no WikiKit-specific CLI is needed. The built-in system guide is deliberately
not copied into `default`: product documentation upgrades with WikiKit, while
user knowledge remains reviewed, portable, and under the user's control.
