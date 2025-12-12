# `src`

Primary TypeScript source for the Nexus Obsidian plugin (including the in-app MCP server).

## What's Here

- Entry points:
  - `main.ts` — Obsidian plugin lifecycle and high-level wiring.
  - `connector.ts` — MCP orchestration, agent registration, and `get_tools` meta-tool handling.
  - `server.ts` / `server/` — MCP server implementation (transport, handlers, execution).
  - `settings.ts` / `settings/` — Settings UI and plugin configuration.
- Major subsystems:
  - `agents/` — Tool surface area (agents + modes).
  - `services/` — LLM, MCP connection, chat, tracing, workspace/session services.
  - `database/` — sql.js-backed persistence, repositories, schema, sync/caching.
  - `ui/` + `components/` — Chat UI and shared components.
  - `utils/` + `types/` — Shared helpers and type definitions.

## Improvement Ideas

- Standardize tool identity conventions (`agent_mode` vs `agent`+`mode`) in one canonical utility.
- Reduce `any` at tool/LLM boundaries by defining shared request/response types.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
