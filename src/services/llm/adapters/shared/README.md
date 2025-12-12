# `src/services/llm/adapters/shared`

## Purpose
LLM adapter for provider "shared" (requests, streaming, tool-calls).

## What's Here
- Subfolders: _None_
- Files: `MCPToolExecution.ts`, `ReasoningPreserver.ts`, `ToolCallContentParser.ts`

## Improvement Ideas
- Consolidate shared HTTP/streaming/error-mapping logic across adapters.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
