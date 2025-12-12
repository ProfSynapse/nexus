# `src/services`

Cross-cutting services used by the plugin, server, agents, and UI.

## What's Here

- MCP integration:
  - `mcp/` — connection management and tool-call routing.
  - `mcp-bridge/` — provider-specific bridging layers for tool invocation (when applicable).
- LLM integration:
  - `llm/` — adapters for multiple providers, streaming utilities, validation, provider manager.
- Session/workspace + memory:
  - `session/`, `workspace/`, `memory/`, `trace/` — continuity + persistence of context/traces.
- Chat/UI support:
  - `chat/` — conversation/session coordination used by the native chat view.
- Infrastructure:
  - `storage/`, `migration/`, `registry/`, `search/` — supporting services.

## Improvement Ideas

- Consolidate tool-call context normalization into a single service/helper used by all entry points.
- Reduce adapter duplication by extracting shared streaming + error mapping utilities for LLM providers.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
