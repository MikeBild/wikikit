# Use WikiKit from a coding agent

A coding agent starts a session without your project's conventions. WikiKit
closes that loop: the session starts grounded in reviewed knowledge, and new
durable rules the user teaches can return as proposals for human review.

Nothing becomes knowledge without approval. Capture always produces a
proposal, never a live change.

## Default setup: MCP only

Connect the agent to WikiKit's Streamable HTTP endpoint:

```text
https://YOUR-WIKIKIT-HOST/mcp
```

The built-in [agent guide](agent-guide.md) contains capability-based setup for
MCP settings screens, TOML configurations, JSON configurations, hosted agents,
OAuth, and API-key authentication. WikiKit requires no client-specific plugin,
CLI, copied mega-prompt, repository manifest, or fixed list of spaces.

On connection, the server provides:

- compact workflow rules in the MCP `initialize` response;
- immutable system knowledge through `wikikit_guide` and
  `wikikit://system/agent-guide`;
- `wikikit_context` for task-dynamic selection across all visible spaces;
- search, read, provenance, proposal, and permission-gated review tools.

If no lifecycle hook already supplied context, the agent calls
`wikikit_context` with the current task and optional repository name. Explicit
`manual_spaces` always wins. Full concepts stay on demand through
`wikikit_search` and `wikikit_read`.

## Authentication and scopes

OAuth is the lowest-setup option for an interactive remote client. For local
or non-interactive clients, mint a narrow key over the REST API:

```bash
export WK="http://127.0.0.1:4060" KEY="wk_..."

curl -s -X POST "$WK/v1/api-keys" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"coding-agent","scopes":["knowledge:read"]}'
```

Use an unbound read key when task routing may select any visible space. Bind a
key to one space when the client must never see other knowledge. Add
`knowledge:propose` only for ingest, explicit proposals, or session capture.
Add `knowledge:review` when the agent should inspect proposals and start the
human review. Keep `knowledge:approve` and `admin` out of agent credentials
entirely — `knowledge:approve` is the human-operator scope for the REST
approve/reject endpoints, which agent-held keys must never be able to call.

## Optional lifecycle integration

Lifecycle hooks are an optimization, not a requirement. Configure equivalent
events only when the MCP host supports them:

| Lifecycle moment                 | WikiKit action                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Session start or context restore | Load a compact `GET /v1/agent/briefing`; never preload every concept or space.                 |
| User prompt submission           | Send the current task to `POST /v1/agent/context`; inject only newly relevant space briefings. |
| Session end or stop              | Optionally send the normalized transcript to `POST /v1/spaces/{space}/agent/sessions`.         |

The prompt-time action is the important dynamic step. Space choice comes from
stable `settings.agent_context` metadata, not from incidental facts inside
concept pages. A user can explicitly request any visible combination, for
example `space: payments+blog` or `wikikit: infra+design-system`.

Automatically guessed spaces are never capture targets. Capture requires an
explicitly configured project space because writes must not be routed by a
guess.

### Example hook scripts

[`examples/agent-hooks/`](../examples/agent-hooks) ships one product-neutral
script per lifecycle moment, as a `.sh`/`.ps1` pair (POSIX sh + curl + jq for
macOS/Linux, PowerShell 5.1 for Windows — no Node or Python required):

| Lifecycle moment       | Scripts                                        |
| ---------------------- | ---------------------------------------------- |
| Session start          | `wikikit-briefing.sh` / `wikikit-briefing.ps1` |
| User prompt submission | `wikikit-context.sh` / `wikikit-context.ps1`   |
| Session end or stop    | `wikikit-capture.sh` / `wikikit-capture.ps1`   |

All six share one contract: stdin is the host's JSON event, stdout is injected
into the session, and they **always exit 0** — a knowledge base being down
must never break a session, and exit code 2 would tell the host to block the
event. They read `~/.wikikit/env` (or `~\.wikikit\env.ps1`), where environment
variables always win over stored values. The context scripts are the shipped
consumers of the optional `.wikikit/agent.json` project manifest below.

### Install the hooks

Every WikiKit server serves its own installer with the base URL pre-resolved:

```bash
# macOS / Linux
curl -fsSL https://YOUR-WIKIKIT-HOST/install.sh | sh
```

```powershell
# Windows
powershell -ExecutionPolicy Bypass -c "irm https://YOUR-WIKIKIT-HOST/install.ps1 | iex"
```

The installer detects installed harnesses (`~/.claude`, `~/.codex`,
`~/.cursor`), downloads the hook scripts to `~/.wikikit/hooks/`, and merges the
hook entries into each harness config. It never clobbers: existing entries are
preserved, the first real change keeps a one-time `.wikikit-backup`, re-running
is an idempotent upgrade, and `--uninstall` removes exactly the wikikit
entries. Keyless installs are valid — hooks stay dormant until a key lands in
`~/.wikikit/env` (chmod 600). Secrets never enter harness configs: Codex uses
`bearer_token_env_var`, and MCP registration for Claude Code and Cursor is
printed as instructions rather than executed. Flags: `--url`, `--key`,
`--space`, `--yes`, `--no-mcp`, `--uninstall` (the Windows installer reads the
equivalent `WIKIKIT_*` environment variables).

This agent hooks installer is unrelated to the repository's
`bun run hooks:install`, which installs git pre-push hooks for contributors.

### Harness wiring

What the installer writes (or what to merge manually):

**Claude Code** — `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "command", "command": "$HOME/.wikikit/hooks/wikikit-briefing.sh", "timeout": 30 }]
      }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "$HOME/.wikikit/hooks/wikikit-context.sh", "timeout": 30 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "$HOME/.wikikit/hooks/wikikit-capture.sh", "timeout": 60 }] }
    ]
  }
}
```

**Codex** — `~/.codex/hooks.json` with the same entry shape, except the
terminal event is named `Stop` (Codex has no `SessionEnd`). Recent Codex
versions enable hooks by default; older ones need `[features] hooks = true` in
`~/.codex/config.toml`. On Windows, Codex additionally supports a
`command_windows` field per entry for a PowerShell alternative command.

**Cursor** — `~/.cursor/hooks.json` (the `"version": 1` field is required):

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "$HOME/.wikikit/hooks/wikikit-briefing.sh" }],
    "beforeSubmitPrompt": [{ "command": "$HOME/.wikikit/hooks/wikikit-context.sh" }],
    "stop": [{ "command": "$HOME/.wikikit/hooks/wikikit-capture.sh" }]
  }
}
```

Cursor's hook surface is newer than the other two — verify event names and
whether `beforeSubmitPrompt` stdout injects context against current Cursor
documentation; if it does not, use Cursor with context via MCP
(`wikikit_context`) plus capture via `stop`.

On native Windows the installer wires the `.ps1` variants through
`powershell -NoProfile -ExecutionPolicy Bypass -File ...` command strings, so
none of the hooks depend on Git Bash being installed.

### Optional project manifest

A host-side lifecycle adapter may use `.wikikit/agent.json` to pin a stable
project space and limits:

```json
{
  "schema_version": 1,
  "primary_space": "payments",
  "budget_tokens": 1200,
  "max_active_spaces": 6,
  "capture": true
}
```

The manifest is optional and is not consumed by the WikiKit server itself. It
is a small convention for lifecycle adapters — the shipped
`wikikit-context.sh`/`.ps1` hooks read `primary_space` and `budget_tokens`
from it; pure MCP clients do not need it.

## Session capture

The capture endpoint distils only durable rules a human explicitly taught or
corrected. A routine session correctly returns `no_learnings` and writes
nothing. The transcript is distilled and dropped rather than archived because
transcripts often contain secrets and unfinished reasoning.

Captured rules enter the normal ChangeProposal review gate. Re-teaching the
same rule converges on the same content hash instead of piling up duplicates.

## Review

An agent may stage with `knowledge:propose`, but publishing remains a distinct
human decision. These curl commands are the human operator's journey — run by
a person with a credential issued to that person, never by the agent or an
automation acting for it:

```bash
curl -s "$WK/v1/spaces/default/proposals?status=pending" -H "Authorization: Bearer $KEY"
curl -s "$WK/v1/proposals/<id>" -H "Accept: text/markdown" -H "Authorization: Bearer $KEY"
curl -s -X POST "$WK/v1/proposals/<id>/approve" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"note":"yes"}'
```

The MCP review tools enforce the boundary directly. First inspect the complete
diff with `wikikit_proposals`, then call `wikikit_review_proposal` with only
`proposal_id`. On a form-capable client WikiKit opens a native form; the human
selects approve/reject and may add the audit note. The agent cannot pass the
decision — `decision`/`note` as tool input are refused with
`approval_requires_human`. Decline, cancel, timeout, or invalid form data
leaves the proposal pending.

On a client without form elicitation the tool returns
`outcome: "human_review_required"` with a `review_url` instead: the proposal
stays pending, the agent gives the user that link — WikiKit's embedded review
page, where the human decides with their own reviewer key — and checks
`wikikit_proposals` later for the outcome. With a review-scoped key the agent
never collects the decision in chat and never calls the REST review endpoints
on the human's behalf. Only a key the operator deliberately granted
`knowledge:approve` sanctions executing the user's explicit chat instruction
over REST (quoted in the audit note) — the hand-off instructions state this
per key.

For Codex, keep elicitation routed to the person:

```toml
approval_policy = { granular = { mcp_elicitations = true } }
approvals_reviewer = "user"
```

Claude Code 2.1.76+ is a supported review host. Treat ChatGPT as conditional:
reconnect the connector and run a form-capability canary; without native form
elicitation the review hands off to an out-of-band human as described above.
Successful audits distinguish `mcp_elicitation` from `rest` in
`review_channel`.

## Troubleshooting

| Symptom                                   | Cause and fix                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No context appears                        | Verify the MCP connection and `knowledge:read`; then call `wikikit_context` directly with the current task.                                                                                                                                      |
| The wrong space activates                 | Fix stable `settings.agent_context` aliases or keywords. Do not add temporary facts as routing triggers.                                                                                                                                         |
| Capture does nothing                      | This is expected when the user taught no durable rule or no explicit capture space exists.                                                                                                                                                       |
| The agent says knowledge is saved         | It is only proposed until a human approves the ChangeProposal.                                                                                                                                                                                   |
| A tools-only client cannot read resources | Call `wikikit_guide`; it exposes the same built-in operating knowledge as a read-only tool.                                                                                                                                                      |
| Review returns `human_review_required`    | The client cannot show the native review form. The proposal stays pending; give the user the returned `review_url` so they decide on the review page; the agent polls `wikikit_proposals`. Never approve via chat or REST on the human's behalf. |
| Review returns `approval_requires_human`  | The agent passed `decision`/`note` as tool input. The tool takes only `proposal_id`; the decision is collected from the human by WikiKit, never by the agent.                                                                                    |
