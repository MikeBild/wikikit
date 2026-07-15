# Concept frontmatter reference

The Markdown-tree bundle (`GET /v1/spaces/{space}/export?format=md`) stores
each concept as `concepts/<slug>.md`: the knowledge structure (claims,
citations, relations) lives in YAML frontmatter, the page prose is the
Markdown body. The same shape is parsed back by
`POST /v1/spaces/{space}/import?format=md` — claims and relations round-trip
**losslessly**, which is what makes the bundle a real interchange format and
not just a rendering.

## Complete example

```markdown
---
title: Open Knowledge Format
summary: Google's markdown-based knowledge bundle format.
claims:
  - subject: open-knowledge-format
    predicate: has_status
    object: draft
    status: verified
    confidence: 0.9
    citations:
      - source: af7e01419480668317d0742889a2e65157d5df4eadce4f2c6c44a79f37bfc83d
        quote: OKF is a draft spec for knowledge bundles.
        locator: 'heading: Status'
relations:
  - to: wikikit
    kind: related
---

# Open Knowledge Format

OKF represents knowledge as markdown files with YAML frontmatter.
See [[wikikit]] for our implementation.
```

## Field reference

### Top level

| Field       | Required                                                | Meaning                                                    |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `title`     | no (falls back to the first `#` heading, then the slug) | Concept title                                              |
| `summary`   | no                                                      | One-line summary; used in the concept index and `index.md` |
| `claims`    | no                                                      | List of claim objects (below)                              |
| `relations` | no                                                      | List of relation objects (below)                           |

The **slug** is the filename stem (`concepts/<slug>.md`), grammar
`^[a-z0-9][a-z0-9-]{0,126}$`; anything else is slugified on import.

### Claim

| Field        | Required                | Meaning                                                                                                                                                                         |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subject`    | yes                     | What the claim is about — a concept slug where possible                                                                                                                         |
| `predicate`  | yes                     | From the space's controlled vocabulary (e.g. `is`, `has_status`, `depends_on`)                                                                                                  |
| `object`     | yes                     | The claimed value                                                                                                                                                               |
| `status`     | no (default `verified`) | Exported as information; **re-derived by the review gate on import** — imported claims stage as `proposed` and become `verified` on approve (exact-frame collisions re-dispute) |
| `confidence` | no (default `0.5`)      | `0..1`; serialized with four decimals                                                                                                                                           |
| `citations`  | no                      | Provenance list (below); claims without citations trigger the `missing-citations` lint error after approval                                                                     |

Two claims with the same `subject` + `predicate` but a different `object` are
an exact-frame contradiction — on approval both flip to `disputed`.

### Citation

| Field     | Required | Meaning                                                                                                                                                     |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`  | yes      | The cited source's **content hash** — the filename stem of `sources/<hash>.md` in the same bundle. Hashes, not ids: identifiers never travel across systems |
| `quote`   | yes      | Verbatim excerpt supporting the claim                                                                                                                       |
| `locator` | no       | Where in the source, e.g. `'heading: Status'` or `'lines 40-52'`                                                                                            |

### Relation

| Field  | Required | Meaning                                                                |
| ------ | -------- | ---------------------------------------------------------------------- |
| `to`   | yes      | Target concept slug                                                    |
| `kind` | yes      | One of `related`, `part_of`, `depends_on`, `contradicts`, `supersedes` |

## The rest of the bundle

```
index.md               TOC with [[slug]] wiki links — derived; ignored on import
log.md                 audit narrative (proposal, reviewer, model) — derived; ignored on import
concepts/<slug>.md     this format
decisions/<slug>.md    title/status/context/decision/rationale/alternatives in frontmatter
sources/<hash>.md      kind/url/title in frontmatter; body = raw content VERBATIM
                       (sha256 of the body must reproduce the filename hash)
```

Wiki links (`[[slug]]`) make the tree browsable in Obsidian as-is. Import
never bypasses review: sources are archived directly, but all concepts,
claims and decisions from a bundle are staged as **one ChangeProposal**.
