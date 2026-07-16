---
title: No CLI product
status: active
context: WikiKit is headless by design.
decision: Ship only HTTP/REST and MCP interfaces, no CLI commands.
rationale: One interface surface keeps drift detection tractable.
alternatives:
  - option: full CLI
    reason_rejected: duplicates the REST surface
---
