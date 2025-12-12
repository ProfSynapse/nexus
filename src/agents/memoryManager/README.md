# `src/agents/memoryManager`

Memory agent: manages workspaces, sessions, state snapshots, and activity traces stored locally.

## What's Here

- `modes/` — workspace/session/state operations exposed as tools.
- `services/` — memory persistence and trace helpers.
- `validators/` — input validation rules.
- `utils/` — shared helpers for the memory domain.

## Improvement Ideas

- Align “workspaceId” precedence rules across tools (context vs workspaceContext vs stored session context).
- Keep persistence logic in `src/database/` or services to avoid agent layer bloat.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
