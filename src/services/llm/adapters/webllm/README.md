# `src/services/llm/adapters/webllm`

## Purpose
LLM adapter for provider "webllm" (requests, streaming, tool-calls).

## What's Here
- Subfolders: _None_
- Files: `index.ts`, `types.ts`, `WebLLMAdapter.ts`, `WebLLMEngine.ts`, `WebLLMLifecycleManager.ts`, `WebLLMModelManager.ts`, `WebLLMModels.ts`, `WebLLMVRAMDetector.ts`, `WebLLMWorkerService.ts`

## Improvement Ideas
- Consolidate shared HTTP/streaming/error-mapping logic across adapters.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
