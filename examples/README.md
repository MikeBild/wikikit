# Examples

Sample **source documents** to ingest into WikiKit — inputs to the service,
never bundled — plus the reference for the concept frontmatter format that
export/import bundles use.

| File                                                                   | What it is                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`okf-announcement.md`](okf-announcement.md)                           | An article-style source: factual statements the synthesizer turns into claims with citations.                                                                                                |
| [`meeting-notes.md`](meeting-notes.md)                                 | A meeting-style source with decision markers: the synthesizer proposes decision records (context, rationale, alternatives) alongside claims.                                                 |
| [`concept-frontmatter-reference.md`](concept-frontmatter-reference.md) | Reference for the `concepts/<slug>.md` frontmatter in `?format=md` bundles — the lossless claims/relations round-trip format.                                                                |
| [`agent-hooks/`](agent-hooks)                                          | Product-neutral SessionStart/SessionEnd examples — load a compact briefing and capture what the user taught. Setup: [docs/coding-agent-integration.md](../docs/coding-agent-integration.md). |

## Ingest a source

```bash
export WK="http://127.0.0.1:4060" KEY="wk_..."

curl -s -X POST "$WK/v1/spaces/default/ingest" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  --data "$(jq -n --rawfile md examples/okf-announcement.md \
      '{markdown: $md, title: "OKF announcement"}')"
```

A PDF, DOCX, XLSX or CSV goes in as the raw body instead — the `?filename=`
extension picks the extractor, and the extracted Markdown follows the same
path:

```bash
curl -s -X POST "$WK/v1/spaces/default/ingest/document?filename=report.pdf" \
  -H "Authorization: Bearer $KEY" --data-binary @report.pdf
```

Ingest answers `202` with an `ingest_id`; poll `GET /v1/ingests/{id}` until
`done`, review the proposal at `GET /v1/proposals/{proposal_id}` (add
`-H "Accept: text/markdown"` for a chat-readable diff), then approve it with
`POST /v1/proposals/{proposal_id}/approve`. Re-ingesting the identical file
answers `409 already_ingested` — the pipeline is idempotent by content hash.

Ingesting the two sources in order demonstrates contradiction detection: they
disagree about OKF's production readiness, so the second proposal flags the
conflicting claim pair, and after approval both claims are `disputed` (visible
in `GET /v1/spaces/default/lint` and reported by `POST .../query`).
