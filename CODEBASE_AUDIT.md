# Codebase Audit (Nexus MCP for Obsidian)

This repo is an Obsidian plugin + companion MCP connector that exposes agents + modes as MCP tools, with a `get_tools` meta-tool for bounded-context discovery.

This audit focuses on:
- How responsibilities are currently partitioned by folder
- Cross-cutting patterns that add complexity or drift risk
- Practical consolidation / pruning opportunities

## Architecture At A Glance

- Obsidian plugin entry: `src/main.ts` (plugin lifecycle) + settings/UI wiring
- MCP orchestration: `src/connector.ts` (agent registration, session/workspace context, `get_tools` meta-tool)
- MCP server implementation: `src/server/` (transport, handlers, lifecycle, execution)
- Tool surface area: `src/agents/` (domain agents) and their `modes/` (individual capabilities)
- Service layer: `src/services/` (LLM, chat, tracing, workspace/session services, MCP connection manager)
- Persistence: `src/database/` (sql.js/SQLite schema + repositories + cache/sync support)
- UI: `src/ui/` (chat view components/controllers/coordinators) + `src/components/`
- Utilities & types: `src/utils/`, `src/types/`

## What's Strong

- Bounded discovery: `get_tools` reduces startup schema bloat and encourages domain-first tool selection
- Clear domain seams: agents roughly align to content vs filesystem vs search vs memory vs prompts vs commands
- Session/workspace continuity: `SessionContextManager` provides a coherent "carry context forward" mechanism
- Persistence model: schema supports workspaces/sessions/states/traces + conversation/message history and FTS

## Improvement Opportunities (Cross-Cutting)

### 1) Tool Identity + Routing Consistency

There are multiple tool identity conventions in play:
- Discovery and some tracing flows refer to tools like `agent_mode` (e.g. `contentManager_readContent`).
- MCP server execution routes per-agent tools and expects `mode` in the arguments (e.g. tool name `contentManager`, args `{ "mode": "readContent", ... }`).

This is workable, but it creates drift risk:
- multiple ad-hoc parsers with different assumptions
- more glue code to translate between representations (and more places to break)

Suggested consolidation:
- Pick one canonical internal representation (`{ agentName, modeName }`) and enforce conversion through a single utility module.
- Keep tracing aligned with the same canonical tool identity model.
- Document the public tool-call surface in one place (see `src/services/mcp/TOOL_CALL_CONTRACT.md`).

### 2) Context Handling: Single Source of Truth Enforced Everywhere

The code repeatedly handles:
- `context.sessionId` presence/formatting
- `context.workspaceId` and/or `workspaceContext.workspaceId`
- workspace context inheritance/injection

Suggested consolidation:
- Create a single normalization function that:
  - validates/standardizes session IDs
  - guarantees `context` exists
  - resolves workspace ID precedence rules
  - produces a typed result (e.g. `NormalizedToolContext`)
- Ensure all execution paths call that exactly once (avoid re-validating in each layer).

### 3) Type Safety: Reduce `any` In Tool/LLM Boundaries

There is a lot of `any` usage at the seams (tool params/results, MCP requests, provider responses). This makes refactors risky.

Suggested consolidation:
- Define canonical types for:
  - `ToolCall` (name, args, context)
  - `AgentModeCall` (agent, mode, params)
  - `ToolResult` / error envelope
- Treat JSON schemas as source-of-truth and generate types (or centralize hand-maintained types).

### 4) Documentation Drift + Encoding Artifacts

There have been visible encoding artifacts in markdown (and occasionally in strings), and some folder READMEs that drift from current architecture.

Suggested consolidation:
- Standardize repo docs to UTF-8 and remove corrupted glyph sequences.
- Keep folder READMEs short and descriptive; avoid "example framework" language that doesn't match Nexus.
- Consider a docs-lint step (optional) that flags replacement characters / mojibake.

### 5) Logging Consolidation

There is a general plugin logger (`src/utils/logger.ts`) and LLM-specific logging utilities (`src/services/llm/utils/Logger.ts`). That can be fine, but it can also produce duplicated conventions and inconsistent output.

Suggested consolidation:
- Decide on one base logging API and let subdomains wrap it (child loggers, namespacing).
- Normalize structured fields (provider, model, requestId, sessionId, workspaceId).

### 6) Service Layer Complexity

`ServiceManager` consolidates multiple historical service systems. This is a good direction, but it indicates the dependency graph has been hard to manage.

Suggested consolidation:
- Treat `ServiceManager` as the only public service access surface (avoid parallel registries).
- Add a lightweight "service map" doc (or auto-generated list) so developers know what's available and when it's initialized.

### 7) Tests (Targeted, Not Exhaustive)

High-value test targets (small, deterministic, low mocking):
- tool name parsing/formatting (canonical utility)
- context normalization (session/workspace precedence)
- schema stripping and schema retrieval logic for `get_tools`
- token/cost extraction in LLM utilities

## Pruning Candidates (Low-Risk)

- Remove or update stale comments referencing removed systems.
- Merge duplicate workspace-context interface definitions where they diverge only by location.
- Re-evaluate folders that only exist to hold 1-2 files (directory sprawl increases navigation cost).

## Quick Wins (Implemented)

- Canonical tool-name parsing: `src/utils/toolNameUtils.ts` now provides `parseAgentToolName(...)`, `parseAgentModeToolName(...)`, and `resolveAgentMode(...)`.
- Tool-call contract doc: `src/services/mcp/TOOL_CALL_CONTRACT.md` (linked from `src/services/mcp/README.md`).
- Trace identity consistency: `src/services/trace/ToolCallTraceService.ts` resolves `(agent, mode)` via `resolveAgentMode(...)` and prefers `params.mode` when available.
- Encoding cleanup for docs: key READMEs and audit docs were rewritten to plain ASCII to avoid mojibake in terminals.

