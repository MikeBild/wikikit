---
title: No CLI product
status: active
context: WikiKit is headless like ContentKit and SlideKit.
decision: Ship only HTTP/REST and MCP interfaces, no CLI commands.
rationale: One interface surface keeps drift detection tractable.
alternatives:
  - option: full CLI
    reason_rejected: duplicates the REST surface
---
