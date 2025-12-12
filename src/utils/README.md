# `src/utils`

Shared utilities used across agents, services, server, and UI (schema helpers, validation, context normalization, misc helpers).

## What's Here

- `schemas/` — schema building utilities and services.
- `validation/` — reusable validation helpers (rules, result builders).
- cross-cutting helpers like logging, context/session utilities, error helpers.

## Improvement Ideas

- Avoid “catch-all” growth: promote stable subsystems into named modules (or services) instead of piling into `utils/`.
- Consolidate duplicated “context/workspace parsing” logic into one canonical helper.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
