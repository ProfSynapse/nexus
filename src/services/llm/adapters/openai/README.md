# `src/services/llm/adapters/openai`

## Purpose
LLM adapter for provider "openai" (requests, streaming, tool-calls).

## What's Here
- Subfolders: _None_
- Files: `DeepResearchHandler.ts`, `OpenAIAdapter.ts`, `OpenAIImageAdapter.ts`, `OpenAIMCPHandler.ts`, `OpenAIModels.ts`

## Improvement Ideas
- Consolidate shared HTTP/streaming/error-mapping logic across adapters.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
