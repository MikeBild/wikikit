# Google announces the Open Knowledge Format (OKF)

In June 2026 Google published the Open Knowledge Format (OKF), an open
specification for portable knowledge bundles, as part of its
knowledge-catalog project.

## What OKF is

OKF represents knowledge as a directory of Markdown files with YAML
frontmatter, packaged with a manifest. Each document declares a `type` (for
example `concept`, `source`, or `decision`), and the bundle-root index file
carries the manifest, including the `okf_version` field.

The stated goal is vendor-neutral knowledge exchange: a bundle produced by one
tool can be consumed by any agent or knowledge system without a proprietary
API. Markdown was chosen as the carrier because both humans and language
models read it natively.

## Status

The published specification is version 0.1 and is explicitly labeled a draft.
The announcement notes that breaking changes are still possible before a 1.0
release, and that the reference validator covers only the core document types
so far. Google invites feedback through the knowledge-catalog repository.

## Why it matters

Agent ecosystems currently exchange knowledge through ad-hoc formats — every
vendor's export is another parser. A common bundle format would let a
knowledge base hand its content to any agent runtime, and let organizations
treat curated knowledge as a portable artifact rather than a database dump.
