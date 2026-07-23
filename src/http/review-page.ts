// The human review page — the out-of-band surface for clients that cannot
// present MCP form elicitation (ChatGPT connectors). One embedded HTML
// document, same self-contained pattern as the OAuth consent page: no external
// assets, data fetched client-side with the reviewer's own credential, so the
// decision never travels through an agent. The shell itself is public and
// content-free; everything knowledge-bearing arrives via the authenticated
// /v1 API from the reviewer's browser.
//
// 0020 grew this into a thin knowledge-ops surface — line diff, claims with
// their citation quotes, collision/stale highlighting, staged-content lint,
// sources, defer-per-concept and request-changes — while staying exactly what
// it was: a THIN client where every button maps 1:1 to a REST endpoint and
// the page ships zero external bytes (CSP unchanged).

/** Strict CSP: inline style/script only, network only to WikiKit itself. */
export const REVIEW_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

/**
 * Dependency-free line diff (classic LCS backtrack). Exported for unit tests
 * AND stringified verbatim into the page's inline script — one
 * implementation, zero drift between what tests cover and what reviewers see.
 * Returns null when the inputs exceed the size guard (caller falls back to
 * side-by-side <pre> blocks). Ops: ' ' context, '-' removed, '+' added.
 */
export function lineDiff(oldText: string, newText: string): { op: ' ' | '-' | '+'; text: string }[] | null {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  // Size guard (~3000 lines / 4M cells): beyond this the page falls back to
  // old/new <pre> blocks. Inlined literals — this function is stringified
  // into the page, so it must stay self-contained.
  if (a.length > 3000 || b.length > 3000 || a.length * b.length > 4000000) return null
  const width = b.length + 1
  // Uint32 LCS table, flat for memory locality.
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  const out: { op: ' ' | '-' | '+'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] ?? '' })
      i++
      j++
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push({ op: '-', text: a[i] ?? '' })
      i++
    } else {
      out.push({ op: '+', text: b[j] ?? '' })
      j++
    }
  }
  while (i < a.length) out.push({ op: '-', text: a[i++] ?? '' })
  while (j < b.length) out.push({ op: '+', text: b[j++] ?? '' })
  return out
}

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
  body { font: 15px/1.55 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; } h3 { font-size: .95rem; margin: 1rem 0 .35rem; }
  code, pre { font-family: ui-monospace, monospace; font-size: .85rem; }
  pre { padding: .75rem; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
  .muted { opacity: .7; } .error { color: #c0392b; } .warn { color: #b9770e; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; border: 1px solid currentColor; font-size: .8rem; margin-left: .35rem; }
  .badge.alert { color: #c0392b; }
  .banner { border: 1px solid #b9770e; border-radius: 6px; padding: .6rem .8rem; margin: .75rem 0; }
  .card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; }
  .diff { font-family: ui-monospace, monospace; font-size: .82rem; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 6px; overflow-x: auto; padding: .4rem 0; }
  .diff div { padding: 0 .6rem; white-space: pre-wrap; }
  .diff .add { background: color-mix(in srgb, #1e7d32 18%, transparent); }
  .diff .del { background: color-mix(in srgb, #c0392b 18%, transparent); text-decoration: line-through; text-decoration-thickness: 1px; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: top; }
  details { margin: .15rem 0; } summary { cursor: pointer; }
  input[type=password], textarea { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 6px; background: transparent; color: inherit; }
  button { font: inherit; padding: .5rem 1.1rem; border-radius: 6px; border: 1px solid transparent; cursor: pointer; margin-right: .5rem; }
  button.approve { background: #1e7d32; color: #fff; } button.reject { background: #c0392b; color: #fff; }
  button.changes { background: #b9770e; color: #fff; }
  button.plain { background: transparent; border-color: color-mix(in srgb, currentColor 35%, transparent); color: inherit; font-size: .85rem; padding: .3rem .7rem; }
  label { display: block; margin: .75rem 0 .25rem; }
  section { margin-top: 1rem; }
  ul { margin: .35rem 0; padding-left: 1.2rem; }
</style>
</head>
<body>
<h1>WikiKit proposal review</h1>
<p class="muted">Proposal <code id="pid"></code></p>

<section id="auth">
  <p>This decision is yours, not an agent's. Authenticate with a reviewer API key —
  <code>knowledge:approve</code> to decide, <code>knowledge:review</code> to inspect,
  defer and request changes. It is sent only to this WikiKit server.</p>
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
  <label for="note">Review note (optional for approve/reject, REQUIRED for request-changes; audited)</label>
  <textarea id="note" rows="2" maxlength="2000"></textarea>
  <p style="margin-top:.75rem">
    <button class="approve" id="approve">Approve</button>
    <button class="changes" id="request-changes">Request changes</button>
    <button class="reject" id="reject">Reject</button>
  </p>
  <p class="muted">Approve/Reject need <code>knowledge:approve</code>; request-changes and defer work with
  <code>knowledge:review</code>. Request-changes rejects terminally with your note as the revision brief —
  the agent re-proposes against it.</p>
</section>

<script>
"use strict";
const PROPOSAL_ID = ${JSON.stringify(proposalId)};
// Channel provenance only (audit trail: url_elicitation instead of rest) —
// no auth effect; the reviewer key is still the only identity.
const VIA = new URLSearchParams(location.search).get("via") === "elicitation" ? "url_elicitation" : null;
const lineDiff = ${lineDiff.toString()};
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
  if (!response.ok) {
    if (response.status === 403) throw new Error("this key may not perform that action (approve/reject need knowledge:approve) — " + (body.error || "forbidden"));
    throw new Error(body.error ? body.code + " — " + body.error : "HTTP " + response.status);
  }
  return body;
}

function diffHtml(oldText, newText) {
  if (oldText === null || oldText === undefined) {
    return '<div class="diff">' + newText.split("\\n").map((line) => '<div class="add">' + esc(line) + "</div>").join("") + "</div>";
  }
  const ops = lineDiff(oldText, newText);
  if (!ops) {
    return '<p class="muted">document too large for an inline diff — old, then new:</p><pre>' + esc(oldText) + "</pre><pre>" + esc(newText) + "</pre>";
  }
  return '<div class="diff">' + ops.map((entry) =>
    '<div class="' + (entry.op === "+" ? "add" : entry.op === "-" ? "del" : "ctx") + '">' + esc(entry.text) + "</div>"
  ).join("") + "</div>";
}

function claimsTable(concept) {
  const claims = concept.claims ?? [];
  if (!claims.length) return "";
  const rows = claims.map((claim) => {
    const flag = claim.collides ? ' <span class="badge alert">collides</span>' : "";
    const cites = (claim.citations ?? []).map((citation) =>
      "<details><summary>quote" + (citation.source_title ? " — " + esc(citation.source_title) : "") + "</summary><pre>" + esc(citation.quote) + "</pre></details>"
    ).join("");
    const collideNote = claim.collides ? '<p class="warn">conflicts with an existing visible claim on the same frame — approval will mark BOTH disputed</p>' : "";
    return "<tr><td>" + esc(claim.subject) + "</td><td><strong>" + esc(claim.predicate) + "</strong></td><td>" + esc(claim.object) + flag + "</td><td>" + esc(claim.status) + "</td></tr>" +
      (cites || collideNote ? '<tr><td colspan="4">' + collideNote + cites + "</td></tr>" : "");
  }).join("");
  return "<h3>Claims (" + claims.length + ")</h3><table><tr><th>subject</th><th>predicate</th><th>object</th><th>status</th></tr>" + rows + "</table>";
}

function render(detail, lint) {
  const pending = detail.status === "pending";
  const parts = [];
  let badges = '<span class="badge">' + esc(detail.status) + "</span>";
  if (detail.changes_requested) badges += ' <span class="badge alert">changes requested</span>';
  if (detail.parent_proposal_id) badges += ' <span class="badge">split from <a href="/review/' + esc(detail.parent_proposal_id) + '">parent</a></span>';
  parts.push("<h2>" + esc(detail.title) + " " + badges + "</h2>");
  parts.push('<p class="muted">space ' + esc(detail.space) + " · created " + esc(detail.created_at) + (detail.reviewer ? " · reviewed by " + esc(detail.reviewer) + " via " + esc(detail.review_channel) : "") + "</p>");
  if (detail.review_note) parts.push('<p class="muted">review note: ' + esc(detail.review_note) + "</p>");

  const staleConcepts = (detail.concepts ?? []).filter((concept) => concept.stale);
  if (pending && staleConcepts.length) {
    parts.push('<div class="banner warn">⚠ These concepts moved on since this proposal was synthesized: <strong>' +
      staleConcepts.map((concept) => esc(concept.slug)).join(", ") +
      "</strong>. Approval will fail with stale_base — the remedy is re-ingesting the listed sources so synthesis runs against the current revision.</div>");
  }
  if (detail.summary) parts.push("<p>" + esc(detail.summary) + "</p>");

  for (const decision of detail.decisions ?? []) {
    parts.push('<div class="card"><h3>Decision: ' + esc(decision.title) + '</h3><p class="muted">' + esc(decision.context) + "</p><p>" + esc(decision.decision) + "</p></div>");
  }

  const deferable = pending && (detail.concepts ?? []).length > 1;
  for (const concept of detail.concepts ?? []) {
    const flags = (concept.is_new ? ' <span class="badge">new</span>' : "") + (concept.stale ? ' <span class="badge alert">stale</span>' : "");
    const defer = deferable ? ' <button class="plain defer" data-slug="' + esc(concept.slug) + '">Defer this concept</button>' : "";
    const relations = (concept.relations_added ?? []).length
      ? "<h3>Relations</h3><ul>" + concept.relations_added.map((relation) => "<li>" + esc(relation.kind) + " → " + esc(relation.to_slug) + "</li>").join("") + "</ul>"
      : "";
    parts.push('<div class="card"><h3>Concept: ' + esc(concept.slug) + flags + defer + "</h3>" +
      diffHtml(concept.is_new ? null : concept.old_markdown, concept.new_markdown) +
      claimsTable(concept) + relations + "</div>");
  }

  const removed = detail.relations_removed ?? [];
  if (removed.length) {
    parts.push('<h2 class="error">Relations removed (' + removed.length + ")</h2><ul>" +
      removed.map((edge) => '<li class="error">' + esc(edge.from_slug + " " + edge.kind + " → " + edge.to_slug) + " — this active relation will be deactivated on approval</li>").join("") + "</ul>");
  }

  if (lint && (lint.findings ?? []).length) {
    parts.push("<h2>Lint (" + lint.counts.error + " errors, " + lint.counts.warn + " warnings)</h2><ul>" +
      lint.findings.map((finding) => '<li class="' + (finding.severity === "error" ? "error" : finding.severity === "warn" ? "warn" : "muted") + '">[' + esc(finding.rule) + "] " + esc(finding.message) + "</li>").join("") + "</ul>");
  }

  const sources = detail.sources ?? [];
  if (sources.length) {
    parts.push("<h2>Sources (" + sources.length + ")</h2><ul>" +
      sources.map((source) => "<li>" + esc(source.title ?? source.id) + ' <span class="muted">(' + esc(source.kind) + (source.url ? " · " + esc(source.url) : "") + ")</span></li>").join("") + "</ul>");
  }

  $("proposal").innerHTML = parts.join("");
  $("proposal").hidden = false;
  $("decide").hidden = !pending;
  $("auth").hidden = true;
  for (const button of document.querySelectorAll("button.defer")) {
    button.addEventListener("click", () => defer(button.getAttribute("data-slug")));
  }
  note(pending ? "Review the full change, then decide below." : "This proposal has already been reviewed.");
}

async function load() {
  try {
    const detail = await api("/v1/proposals/" + PROPOSAL_ID);
    let lint = null;
    // Lint is additive review context — a failure must never block the diff.
    try { lint = await api("/v1/proposals/" + PROPOSAL_ID + "/lint"); } catch (ignored) {}
    render(detail, lint);
  } catch (error) { fail(error.message); }
}

async function defer(slug) {
  if (!confirm("Defer concept '" + slug + "' into its own proposal? The rest stays here for review.")) return;
  try {
    await api("/v1/proposals/" + PROPOSAL_ID + "/split", { method: "POST", body: JSON.stringify({ concepts: [slug] }) });
    note("Deferred '" + slug + "' into a child proposal. Reloading…");
    await load();
  } catch (error) { fail(error.message); }
}

async function decide(action) {
  const noteValue = $("note").value.trim();
  if (action === "request-changes" && !noteValue) { fail("request-changes needs a note — the note IS the requested change."); return; }
  const prompt = action === "approve" ? "Approve and publish this change?" : action === "reject" ? "Reject this change?" : "Reject with your note as the revision brief?";
  if (!confirm(prompt)) return;
  try {
    const result = await api("/v1/proposals/" + PROPOSAL_ID + "/" + action, { method: "POST", body: JSON.stringify({ ...(noteValue ? { note: noteValue } : {}), ...(VIA ? { via: VIA } : {}) }) });
    $("decide").hidden = true;
    note("Done: " + result.status + (result.changes_requested ? " (changes requested)" : "") + " (review_channel " + result.review_channel + "). You can close this page; the agent sees the outcome via wikikit_proposals.");
  } catch (error) { fail(error.message); }
}

$("load").addEventListener("click", load);
$("approve").addEventListener("click", () => decide("approve"));
$("reject").addEventListener("click", () => decide("reject"));
$("request-changes").addEventListener("click", () => decide("request-changes"));
if (stored) load();
</script>
</body>
</html>
`
}
