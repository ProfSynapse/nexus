# `src/services/llm/adapters/lmstudio`

## Purpose
LLM adapter for provider "lmstudio" (requests, streaming, tool-calls).

## What's Here
- Subfolders: _None_
- Files: `LMStudioAdapter.ts`, `LMStudioModels.ts`, `ToolCallContentParser.ts`

## Improvement Ideas
- Consolidate shared HTTP/streaming/error-mapping logic across adapters.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
