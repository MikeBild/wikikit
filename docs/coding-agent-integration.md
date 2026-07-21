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
Keep `knowledge:approve` and `admin` out of routine agent credentials.

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
example `space: contentkit+blog-de` or `wikikit: ocpp+slidekit`.

Automatically guessed spaces are never capture targets. Capture requires an
explicitly configured project space because writes must not be routed by a
guess.

### Optional project manifest

A host-side lifecycle adapter may use `.wikikit/agent.json` to pin a stable
project space and limits:

```json
{
  "schema_version": 1,
  "primary_space": "contentkit",
  "budget_tokens": 1200,
  "max_active_spaces": 6,
  "capture": true
}
```

The manifest is optional and is not consumed by the WikiKit server itself. It
is a small convention for lifecycle adapters; pure MCP clients do not need it.

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
`outcome: "human_review_required"` instead: the proposal stays pending, the
agent tells the user that a human must review it out-of-band (from a
form-capable client or over REST as themselves), and checks
`wikikit_proposals` later for the outcome. The agent never collects the
decision in chat and never calls the REST review endpoints on the human's
behalf.

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

| Symptom                                   | Cause and fix                                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No context appears                        | Verify the MCP connection and `knowledge:read`; then call `wikikit_context` directly with the current task.                                                                                           |
| The wrong space activates                 | Fix stable `settings.agent_context` aliases or keywords. Do not add temporary facts as routing triggers.                                                                                              |
| Capture does nothing                      | This is expected when the user taught no durable rule or no explicit capture space exists.                                                                                                            |
| The agent says knowledge is saved         | It is only proposed until a human approves the ChangeProposal.                                                                                                                                        |
| A tools-only client cannot read resources | Call `wikikit_guide`; it exposes the same built-in operating knowledge as a read-only tool.                                                                                                           |
| Review returns `human_review_required`    | The client cannot show the native review form. The proposal stays pending; a human reviews it out-of-band; the agent polls `wikikit_proposals`. Never approve via chat or REST on the human's behalf. |
| Review returns `approval_requires_human`  | The agent passed `decision`/`note` as tool input. The tool takes only `proposal_id`; the decision is collected from the human by WikiKit, never by the agent.                                         |
