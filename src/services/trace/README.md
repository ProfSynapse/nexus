# `src/services/trace`

## Purpose
Tool-call tracing and persistence services.

## What's Here
- `ToolCallTraceService.ts`
  - Persists tool executions as workspace/session traces (via `MemoryService`).
  - Resolves `(agent, mode)` using [`src/utils/toolNameUtils.ts`](../../utils/toolNameUtils.ts):
    - MCP server path: `params.mode`
    - Chat View path: `agent_mode` tool naming

## Tool Contract

- See [`src/services/mcp/TOOL_CALL_CONTRACT.md`](../mcp/TOOL_CALL_CONTRACT.md) for naming + argument expectations.

## Improvement Ideas
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
