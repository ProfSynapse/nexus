# `src/services/llm/adapters`

## Purpose
Provider adapter implementations for LLM calls (OpenAI, Anthropic, etc.).

## What's Here
- Subfolders: `anthropic`, `google`, `groq`, `lmstudio`, `mistral`, `ollama`, `openai`, `openrouter`, `perplexity`, `requesty`, `shared`, `webllm`
- Files: `BaseAdapter.ts`, `BaseImageAdapter.ts`, `CostCalculator.ts`, `index.ts`, `ModelRegistry.ts`, `modelTypes.ts`, `types.ts`

## Improvement Ideas
- Consolidate shared HTTP/streaming/error-mapping logic across adapters.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
