# `src/agents/vaultLibrarian`

Search/retrieval agent: finding and formatting information from the vault/workspaces.

## What's Here

- `modes/` — search tools exposed to MCP callers.
- `services/` — retrieval helpers and result formatters.

## Improvement Ideas

- Keep formatting logic reusable across UI and MCP (avoid duplicate formatters).
- Consider a single “query plan” structure shared between search modes.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
