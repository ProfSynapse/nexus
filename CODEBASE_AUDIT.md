# Codebase Audit (Nexus MCP for Obsidian)

This repo is an Obsidian plugin + companion MCP connector that exposes “agents + modes” as MCP tools, with a `get_tools` meta-tool for bounded-context discovery.

This audit focuses on:
- How responsibilities are currently partitioned by folder.
- Cross-cutting patterns that add complexity or drift risk.
- Practical consolidation / pruning opportunities.

## Architecture At A Glance

- **Obsidian plugin entry**: `src/main.ts` (plugin lifecycle) + settings/UI wiring.
- **MCP orchestration**: `src/connector.ts` (agent registration, session/workspace context, `get_tools` meta-tool).
- **MCP server implementation**: `src/server/` (transport, handlers, lifecycle, execution).
- **Tool surface area**: `src/agents/` (domain agents) and their `modes/` (individual capabilities).
- **Service layer**: `src/services/` (LLM adapters/providers, chat sessioning, tracing, workspace/session services, MCP connection manager).
- **Persistence**: `src/database/` (sql.js/SQLite schema + repositories + cache/sync support).
- **UI**: `src/ui/` (chat view components, controllers/coordinators) + `src/components/`.
- **Utilities & types**: `src/utils/`, `src/types/`.

## What's Strong

- **Bounded discovery**: `get_tools` reduces startup schema bloat and encourages domain-first tool selection.
- **Clear domain seams**: agents roughly align to “content vs filesystem vs search vs memory vs prompts vs commands”.
- **Session/workspace continuity**: `SessionContextManager` provides a coherent “carry context forward” mechanism.
- **Persistence model**: the schema supports workspaces/sessions/states/traces + conversation/message history and FTS.

## Improvement Opportunities (Cross-Cutting)

### 1) Tool Identity + Routing Consistency

There are multiple “tool identity” conventions in play:
- **Discovery + tracing** refer to tools like `agent_mode` (e.g. `contentManager_readContent`).
- **Execution routing** often expects **agent tool name** + `mode` argument (e.g. tool name `contentManager`, args `{ mode: "readContent", ... }`).

This is workable, but it creates drift risk:
- multiple `parseToolName(...)` implementations with different assumptions
- more “glue code” to translate between representations (and more places to break)

Suggested consolidation:
- Pick one canonical representation internally (recommend: `{agent, mode}` object), and enforce conversion through a single utility module (one parser, one formatter).
- Make tracing use the same canonical parser as execution (or store both raw + canonical).
- Document the “public” tool-call surface in one place (`src/connector.ts` + a README in `src/services/mcp/`).

### 2) Context Handling: “Single Source of Truth” Enforced Everywhere

The code repeatedly enforces:
- `context.sessionId` presence/formatting
- `context.workspaceId` and/or `workspaceContext.workspaceId`
- workspace context inheritance / injection

Suggested consolidation:
- Create a single normalization function that:
  - validates/standardizes session IDs
  - guarantees `context` exists
  - resolves workspace ID precedence rules
  - produces a typed result (`NormalizedToolContext`)
- Ensure all execution paths call that exactly once (avoid re-validating in each layer).

### 3) Type Safety: Reduce `any` In Tool/LLM Boundaries

There’s a lot of `any` usage at the seams (tool params/results, MCP requests, provider responses). This makes refactors risky.

Suggested consolidation:
- Define canonical types for:
  - `ToolCall` (name, args, context)
  - `AgentModeCall` (agent, mode, params)
  - `ToolResult` / error envelope
- Treat JSON schemas as source-of-truth and generate types (or centralize hand-maintained types).

### 4) Documentation Drift + Encoding Artifacts

There are visible “mojibake”/encoding artifacts in markdown (and occasionally in strings), and at least one folder README that read like a different project.

Suggested consolidation:
- Standardize repo files to UTF-8 and remove corrupted glyph sequences.
- Keep folder READMEs short and descriptive; avoid “example app/framework” language that doesn’t match Nexus.
- Consider a docs-lint step (optional) that flags non-UTF-8 or replacement characters.

### 5) Logging Consolidation

There’s a general plugin logger (`src/utils/logger.ts`) and LLM-specific logging utilities (`src/services/llm/utils/Logger.ts`). That can be fine, but it often turns into duplicated conventions and inconsistent output.

Suggested consolidation:
- Decide on one base logging API and let subdomains wrap it (child loggers, namespacing).
- Normalize structured fields (provider, model, requestId, sessionId, workspaceId).

### 6) Service Layer Complexity

`ServiceManager` explicitly consolidates multiple historical service systems. This is a good direction, but it’s a signal that the dependency graph has been hard to manage.

Suggested consolidation:
- Treat `ServiceManager` as the only public “service access” surface (avoid parallel registries).
- Add a lightweight “service map” doc (or auto-generated list) so developers know what’s available and when it’s initialized.

### 7) Tests (Targeted, Not Exhaustive)

High-value test targets (small, deterministic, low mocking):
- tool name parsing/formatting (canonical utility)
- context normalization (session/workspace precedence)
- schema stripping and schema retrieval logic for `get_tools`
- token/cost extraction in LLM utilities

## Pruning Candidates (Low-Risk)

- Remove or update stale comments referencing removed systems (e.g., “ToolCallCaptureService” mentions where it no longer exists).
- Merge duplicate “workspace context” interface definitions where they diverge only by location.
- Re-evaluate folders that only exist to hold 1–2 files (directory sprawl increases navigation cost).

## Quick Wins

- Unify `parseToolName` in one module; use it in routing + tracing.
- Update misleading READMEs/docs and fix encoding artifacts.
- Add a single “tool-call contract” doc: tool naming + required context + workspace inheritance rules.
