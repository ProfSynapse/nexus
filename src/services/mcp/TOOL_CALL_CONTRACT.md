# Tool Call Contract

This doc describes the tool naming + arguments conventions used across Nexus' MCP surfaces.

## Two Surfaces

1) **MCP server (Claude Desktop / external MCP clients)**
- Tools are registered per **agent** (e.g. `contentManager`, `vaultLibrarian`).
- The **mode** is selected via the `mode` argument.

2) **Native Chat View (bounded-context discovery)**
- The Chat View exposes a `get_tools` meta-tool for on-demand schema discovery.
- Discovered tools are referenced in `agent_mode` form (e.g. `contentManager_readContent`) when schemas are returned.

## Naming

### Agent tools (MCP server)

- Tool name: `agentName`
  - Example: `vaultLibrarian`
- Legacy/compatibility: some older flows used `agentName_<vaultSuffix>`.
  - Vault suffix can contain underscores, so parsing must split on the **first** underscore.

### Mode tools (Chat View discovery)

- Tool name: `agentName_modeName`
  - Example: `contentManager_readContent`

## Arguments

### Common shape (MCP server)

When calling an agent tool, pass:

```json
{
  "mode": "readContent",
  "sessionId": "session_abc123",
  "context": {
    "sessionId": "session_abc123",
    "workspaceId": "default"
  }
}
```

Notes:
- `mode` is required.
- `sessionId` is currently required by the *tool list* schema (legacy).
- `context.sessionId` is treated as the canonical session identifier by execution + tracing.
  - If `context` is missing, the server will create it.
  - If `context.sessionId` is missing, the server will generate/validate a session ID and populate it.
- `context.workspaceId` is strongly recommended for correct workspace binding; otherwise the system falls back to the active session workspace or `"default"`.

### Common shape (Chat View discovery + execution)

- Discovery: call `get_tools` to retrieve schemas (grouped format recommended).
- Execution: call the returned tool name (often `agent_mode`), and include the required `context` block as instructed by `get_tools`.

## Workspace Context Precedence

Workspace ID can come from multiple places; the system prefers:
1) `params.workspaceContext.workspaceId`
2) `params.context.workspaceId`
3) session-bound workspace context (via `SessionContextManager`)
4) `"default"`

## Tracing Expectations

`ToolCallTraceService` resolves `(agent, mode)` by:
- preferring `params.mode` when present (MCP server path), otherwise
- using `agent_mode` parsing from the tool name (Chat View path)

Canonical parsing helpers live in [`src/utils/toolNameUtils.ts`](../../utils/toolNameUtils.ts).
