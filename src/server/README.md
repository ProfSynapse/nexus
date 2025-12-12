# `src/server`

MCP server implementation used by the plugin to expose tools/agents to MCP clients.

## What's Here

- `MCPServer.ts` — the main server implementation (exported via `src/server.ts` for compatibility).
- `handlers/` — request handler wiring/factories.
- `execution/` — agent/mode execution orchestration.
- `transport/` — transport implementations (stdio/IPC).
- `lifecycle/` — start/stop/shutdown management.
- `services/` — server-internal registries/configuration helpers.

## Improvement Ideas

- Unify tool-name parsing/formatting across server + tracing + UI.
- Keep server errors consistently shaped (one MCP error mapping policy).
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
