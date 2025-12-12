# `src/handlers`

## Purpose
Request handling strategies and helper services for MCP/server integration.

## What's Here

- `RequestRouter.ts` selects a strategy for each MCP request (e.g. `tools/list`, `tools/call`).
- `strategies/`
  - `ToolListStrategy.ts` returns agent tools for MCP clients.
  - `ToolExecutionStrategy.ts` executes agent modes and emits tool-response callbacks for tracing.
- `services/` contains validation, schema enhancement, tool list generation, formatting, etc.

## Related Modules

- [`src/server/MCPServer.ts`](../server/MCPServer.ts) (server entry point)
- [`src/services/trace/ToolCallTraceService.ts`](../services/trace/ToolCallTraceService.ts) (records executions)
- [`src/utils/toolNameUtils.ts`](../utils/toolNameUtils.ts) (canonical tool-name parsing)
- [`src/utils/toolContextUtils.ts`](../utils/toolContextUtils.ts) (tool-call context normalization)

## Improvement Ideas
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
