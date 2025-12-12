# `src/services/mcp`

MCP-specific glue code used by the Obsidian plugin to host an MCP server and route tool calls into agents/modes.

## Key Responsibilities

- Connection lifecycle: `MCPConnectionManager.ts` creates `src/server/MCPServer.ts` and manages start/stop/reinit.
- Tool routing: `ToolCallRouter.ts` validates tool calls and dispatches to `MCPServer.executeAgentMode(...)`.

## Tool Contract

- See [TOOL_CALL_CONTRACT.md](./TOOL_CALL_CONTRACT.md) for naming + argument conventions across MCP and the native Chat View.

## Related Modules

- [`src/handlers/RequestRouter.ts`](../../handlers/RequestRouter.ts) (MCP request strategy dispatch)
- [`src/server/README.md`](../../server/README.md) (server internals)
- [`src/services/trace/ToolCallTraceService.ts`](../trace/ToolCallTraceService.ts) (tool-call tracing)
- [`src/utils/toolNameUtils.ts`](../../utils/toolNameUtils.ts) (canonical tool-name parsing/formatting)

## Improvement Ideas

- Keep one canonical tool identity model (`agent` + `mode`) and avoid reintroducing ad-hoc parsing elsewhere.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
