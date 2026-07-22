// The human review page — the out-of-band surface for clients that cannot
// present MCP form elicitation (ChatGPT connectors). One embedded HTML
// document, same self-contained pattern as the OAuth consent page: no external
// assets, data fetched client-side with the reviewer's own credential, so the
// decision never travels through an agent. The shell itself is public and
// content-free; everything knowledge-bearing arrives via the authenticated
// /v1 API from the reviewer's browser.

/** Strict CSP: inline style/script only, network only to WikiKit itself. */
export const REVIEW_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

/** `proposalId` is zIdParams-validated (uuid) before this renders. */
export function renderReviewPage(proposalId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>WikiKit proposal review</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
  code, pre { font-family: ui-monospace, monospace; font-size: .85rem; }
  pre { padding: .75rem; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
  .muted { opacity: .7; } .error { color: #c0392b; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; border: 1px solid currentColor; font-size: .8rem; }
  input[type=password], textarea { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 6px; background: transparent; color: inherit; }
  button { font: inherit; padding: .5rem 1.1rem; border-radius: 6px; border: 1px solid transparent; cursor: pointer; margin-right: .5rem; }
  button.approve { background: #1e7d32; color: #fff; } button.reject { background: #c0392b; color: #fff; }
  button.plain { background: transparent; border-color: color-mix(in srgb, currentColor 35%, transparent); color: inherit; }
  label { display: block; margin: .75rem 0 .25rem; }
  section { margin-top: 1rem; }
</style>
</head>
<body>
<h1>WikiKit proposal review</h1>
<p class="muted">Proposal <code id="pid"></code></p>

<section id="auth">
  <p>This decision is yours, not an agent's. Authenticate with a reviewer API key
  holding <code>knowledge:approve</code>; it is sent only to this WikiKit server.</p>
  <label for="key">Reviewer API key</label>
  <input id="key" type="password" placeholder="wk_..." autocomplete="off">
  <label><input id="remember" type="checkbox"> Remember in this browser</label>
  <p><button class="plain" id="load">Load proposal</button></p>
</section>

<p id="status" class="muted" hidden></p>
<p id="error" class="error" hidden></p>
<div id="proposal" hidden></div>

<section id="decide" hidden>
  <h2>Decision</h2>
  <label for="note">Review note (optional, audited)</label>
  <textarea id="note" rows="2" maxlength="2000"></textarea>
  <p style="margin-top:.75rem">
    <button class="approve" id="approve">Approve</button>
    <button class="reject" id="reject">Reject</button>
  </p>
</section>

<script>
"use strict";
const PROPOSAL_ID = ${JSON.stringify(proposalId)};
const $ = (id) => document.getElementById(id);
$("pid").textContent = PROPOSAL_ID;
const stored = localStorage.getItem("wikikit_reviewer_key");
if (stored) { $("key").value = stored; $("remember").checked = true; }

function fail(message) { $("error").textContent = message; $("error").hidden = false; $("status").hidden = true; }
function note(message) { $("status").textContent = message; $("status").hidden = false; $("error").hidden = true; }
function esc(value) { const div = document.createElement("div"); div.textContent = String(value ?? ""); return div.innerHTML; }

function credential() {
  const key = $("key").value.trim();
  if ($("remember").checked && key) localStorage.setItem("wikikit_reviewer_key", key);
  if (!$("remember").checked) localStorage.removeItem("wikikit_reviewer_key");
  return key;
}

async function api(path, init) {
  const response = await fetch(path, { ...init, headers: { authorization: "Bearer " + credential(), accept: "application/json", ...(init && init.body ? { "content-type": "application/json" } : {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ? body.code + " — " + body.error : "HTTP " + response.status);
  return body;
}

function render(detail) {
  const terminal = detail.status !== "pending";
  const parts = [];
  parts.push('<h2>' + esc(detail.title) + ' <span class="badge">' + esc(detail.status) + '</span></h2>');
  parts.push('<p class="muted">space ' + esc(detail.space) + ' · created ' + esc(detail.created_at) + (detail.reviewer ? ' · reviewed by ' + esc(detail.reviewer) + ' via ' + esc(detail.review_channel) : '') + '</p>');
  if (detail.summary) parts.push('<p>' + esc(detail.summary) + '</p>');
  for (const decision of detail.decisions ?? []) {
    parts.push('<h2>Decision: ' + esc(decision.title) + '</h2><p class="muted">' + esc(decision.context) + '</p><p>' + esc(decision.decision) + '</p>');
  }
  for (const concept of detail.concepts ?? []) {
    parts.push('<h2>Concept: ' + esc(concept.slug) + (concept.is_new ? ' <span class="badge">new</span>' : '') + '</h2>');
    if (concept.old_markdown) parts.push('<p class="muted">replaces an existing revision — review the full diff below</p><pre>' + esc(concept.old_markdown) + '</pre><p class="muted">new revision:</p>');
    parts.push('<pre>' + esc(concept.new_markdown) + '</pre>');
    const claims = (concept.claims_added ?? []).length;
    if (claims) parts.push('<p class="muted">' + claims + ' claim(s) with citations included.</p>');
    const added = concept.relations_added ?? [];
    if (added.length) parts.push('<p class="muted">Relations added: ' + added.map((relation) => esc(concept.slug + ' ' + relation.kind + ' → ' + relation.to_slug)).join(', ') + '</p>');
  }
  const removed = detail.relations_removed ?? [];
  if (removed.length) {
    parts.push('<h2 class="error">Relations removed (' + removed.length + ')</h2><ul>');
    for (const edge of removed) {
      parts.push('<li class="error">' + esc(edge.from_slug + ' ' + edge.kind + ' → ' + edge.to_slug) + ' — this active relation will be deactivated on approval</li>');
    }
    parts.push('</ul>');
  }
  $("proposal").innerHTML = parts.join("");
  $("proposal").hidden = false;
  $("decide").hidden = terminal;
  $("auth").hidden = true;
  note(terminal ? "This proposal has already been reviewed." : "Review the full change, then decide below.");
}

async function load() {
  try { render(await api("/v1/proposals/" + PROPOSAL_ID)); } catch (error) { fail(error.message); }
}

async function decide(action) {
  const noteValue = $("note").value.trim();
  if (!confirm(action === "approve" ? "Approve and publish this change?" : "Reject this change?")) return;
  try {
    const result = await api("/v1/proposals/" + PROPOSAL_ID + "/" + action, { method: "POST", body: JSON.stringify(noteValue ? { note: noteValue } : {}) });
    $("decide").hidden = true;
    note("Done: " + result.status + " (review_channel " + result.review_channel + "). You can close this page; the agent sees the outcome via wikikit_proposals.");
  } catch (error) { fail(error.message); }
}

$("load").addEventListener("click", load);
$("approve").addEventListener("click", () => decide("approve"));
$("reject").addEventListener("click", () => decide("reject"));
if (stored) load();
</script>
</body>
</html>
`
}
