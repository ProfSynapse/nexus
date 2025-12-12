# `src/server/transport`

## Purpose
MCP server implementation (transport, handlers, lifecycle, execution).

## What's Here
- Subfolders: _None_
- Files: `HttpTransportManager.ts`, `IPCTransportManager.ts`, `StdioTransportManager.ts`

## Improvement Ideas
- Centralize tool-name parsing and MCP error shaping across handlers/strategies.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
