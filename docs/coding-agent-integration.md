# Use WikiKit from Claude Code or Codex

Your coding agent starts every session knowing nothing about your project's
conventions. You explain the same rule again next week. WikiKit closes that
loop: a session **starts** grounded in your reviewed knowledge, and what you
teach it **flows back** — as a proposal you approve, so the next session already
knows.

```
  new session ──▶ briefing hook injects your concept index
       │                                    ▲
       ▼                                    │
  you work; the agent looks things          │
  up with wikikit_search / wikikit_read     │
       │                                    │
       ▼                                    │
  session ends ──▶ capture hook ──▶ distil ─┘
                                     │
                        only rules YOU taught
                                     │
                                     ▼
                          ChangeProposal → you approve
```

Nothing becomes knowledge without your approval. Capture always produces
_proposals_.

## Setup (about 2 minutes)

You need WikiKit running ([Quickstart](../README.md#quickstart)), plus `curl`
and `jq`.

### 1. Mint a key for your agent

Not your bootstrap key — scopes are what keep approval a human act:

```bash
export WK="http://127.0.0.1:4060" KEY="wk_..."   # your admin/bootstrap key

curl -s -X POST "$WK/v1/api-keys" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"coding-agent","scopes":["knowledge:read","knowledge:propose"],"space":"default"}'
# → {"key":"wk_...", ...}   ← shown once
```

Put it in your shell profile — both the MCP server and the hooks read it:

```bash
export WIKIKIT_URL="http://127.0.0.1:4060"
export WIKIKIT_API_KEY="wk_..."      # the key you just minted
export WIKIKIT_SPACE="default"
```

### 2. Register the MCP server

This alone already gives the agent `wikikit_search`, `wikikit_read` and
`wikikit_propose`. **Claude Code:**

```bash
claude mcp add --transport http --scope user wikikit "$WIKIKIT_URL/mcp" \
  --header "Authorization: Bearer ${WIKIKIT_API_KEY}"
```

**Codex:**

```bash
codex mcp add wikikit --url "$WIKIKIT_URL/mcp" --bearer-token-env-var WIKIKIT_API_KEY
```

**Claude Desktop** (and most other MCP clients) — in the `mcpServers` config:

```json
{
  "mcpServers": {
    "wikikit": {
      "type": "http",
      "url": "http://127.0.0.1:4060/mcp",
      "headers": { "Authorization": "Bearer wk_..." }
    }
  }
}
```

On connect the server hands the agent its own usage instructions and serves the
full docs as MCP resources, so it needs no further explanation from you.

### ChatGPT.com is OAuth, not an API-key header

For ChatGPT Developer mode, create an app with
`https://wikikit.mikebild.dev/mcp` and choose OAuth. WikiKit performs dynamic
client registration and the PKCE authorization-code flow. Production uses the
same Google/Firebase sign-in bridge as SubKit and an explicit WikiKit email
allow-list; the operator API key is never entered into ChatGPT. ChatGPT
receives only a scoped short-lived token instead.

### 3. Wire the hooks

Copy the two scripts from [`examples/agent-hooks/`](../examples/agent-hooks) and
make them executable:

```bash
mkdir -p ~/.wikikit/hooks
cp examples/agent-hooks/*.sh ~/.wikikit/hooks/
chmod +x ~/.wikikit/hooks/*.sh
```

**Claude Code** — in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [{ "type": "command", "command": "~/.wikikit/hooks/wikikit-briefing.sh", "timeout": 30 }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "~/.wikikit/hooks/wikikit-capture.sh", "timeout": 60 }]
      }
    ]
  }
}
```

The `compact` matcher re-injects the briefing after context compaction, so a
long session does not forget your conventions halfway through.

**Codex** — enable hooks in `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

then in `~/.codex/hooks.json` (Codex has no `SessionEnd`; `Stop` fires per turn,
and repeat captures are cheap — identical rules collapse onto the same content
hash):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [{ "type": "command", "command": "~/.wikikit/hooks/wikikit-briefing.sh", "timeout": 30 }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "~/.wikikit/hooks/wikikit-capture.sh", "timeout": 60 }]
      }
    ]
  }
}
```

Hooks need a one-time trust confirmation via `/hooks` in the Codex TUI.

### Verify

```bash
echo '{}' | ~/.wikikit/hooks/wikikit-briefing.sh
```

You should see your concept index. **Silence is also correct** — with an empty
knowledge base there is nothing to brief, and the hook stays quiet by design.

## What each half does

### Loading (SessionStart)

The briefing prints your concept **index** — slug, title, summary — plus the
rule "look it up, don't guess". Not the pages themselves: the agent fetches
those on demand with `wikikit_read`, which keeps your context window for your
actual work.

### Saving (SessionEnd / Stop)

The transcript goes to `POST /v1/spaces/{space}/agent/sessions`, and the server
distils **only durable rules a human explicitly taught or corrected**:

```
you:   "no — we never deploy by hand, always let CI do it.
        manual deploys skip the migration gate."
       ↓
       ChangeProposal: concept `ci-cd-deployment-policy`
       claims: uses GitHub Actions · manual deploys skip the migration gate · …
       ↓
you:   curl -X POST "$WK/v1/proposals/<id>/approve" ...
```

What it will _not_ do:

- Distil what the assistant said on its own — only what you taught.
- Distil task instructions ("add a test for X"), transient state, or file paths.
- Capture a routine session at all. A session that taught nothing answers
  `{"status":"no_learnings"}` and writes nothing.
- Archive the transcript. It is distilled and dropped — transcripts carry pasted
  secrets and half-formed thoughts, and WikiKit keeps sources forever.

You can also save mid-session, without any hook: say _"remember that…"_ and the
agent calls `wikikit_propose`. Same review gate.

### Review

```bash
curl -s "$WK/v1/spaces/default/proposals?status=pending" -H "Authorization: Bearer $KEY"
curl -s "$WK/v1/proposals/<id>" -H "Accept: text/markdown" -H "Authorization: Bearer $KEY"
curl -s -X POST "$WK/v1/proposals/<id>/approve" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"note":"yes"}'
```

Approved knowledge shows up in the very next session's briefing. Re-teaching the
same rule does not pile up duplicates — identical rules produce the same content
hash and answer `already_captured`.

## Troubleshooting

| Symptom                                | Cause and fix                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The briefing prints nothing            | By design in every failure case — a knowledge base being down must never break your session. Check in order: `WIKIKIT_API_KEY` set? `jq` installed? WikiKit reachable? Any approved concepts yet (proposals are invisible until approved)? |
| Capture seems to do nothing            | Expected for a routine session. Run with `WIKIKIT_HOOK_DEBUG=1` and read `~/.wikikit/hook.log` — it records the actual answer.                                                                                                             |
| `{"status":"no_learnings"}` every time | The distiller only takes rules **you** stated. Teach it explicitly ("never do X, always do Y") rather than implying it.                                                                                                                    |
| `503 llm_not_configured` on capture    | Capture needs the LLM. Set the key for your `WIKIKIT_LLM_PROVIDER` (see [Configuration](CONFIGURATION.md)). Loading keeps working without it.                                                                                              |
| The agent says knowledge is "saved"    | It is _proposed_, not live. Approve it — nothing enters the knowledge base without that.                                                                                                                                                   |

## Related

- [README](../README.md) — what WikiKit is, and the quickstart.
- [Configuration](CONFIGURATION.md) — every environment variable.
- [Architecture](ARCHITECTURE.md) — the knowledge lifecycle these hooks ride on.
