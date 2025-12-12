# `src/database`

Local persistence layer (sql.js/SQLite) backing workspaces, sessions, states, traces, and chat history.

## What's Here

- `schema/` — SQL schema definition (tables, indexes, FTS, version tracking).
- `adapters/` — storage adapters (sql.js integration, file IO).
- `repositories/` — repositories per entity (workspaces/sessions/states/messages/etc).
- `migration/` — schema/data migrations.
- `services/` — caching and database service utilities.
- `sync/` — sync primitives/state tracking (if enabled/used).
- `types/` — typed DB models and cache/session/workspace types.

## Improvement Ideas

- Add small tests around migrations and repository contracts to prevent schema drift.
- Keep entity types in one canonical place (avoid “types” duplication across layers).
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
