# `src/services/llm/utils`

Shared utilities used by the LLM subsystem (provider adapters, streaming, validation, and cost/token accounting).

## What’s Here

- `ConfigManager.ts` — centralizes provider configuration (API keys, defaults, feature toggles).
- `Logger.ts` — LLM-scoped logging helpers (provider/model aware).
- `RetryManager.ts` — retry/backoff/circuit-breaker style utilities for unstable provider calls.
- `SchemaValidator.ts` / `ValidationUtils.ts` — schema and parameter validation helpers.
- `TokenUsageExtractor.ts` — normalizes token usage extraction from provider responses.
- `LLMCostCalculator.ts` — computes estimated cost from usage + model/provider pricing metadata.
- `ThinkingEffortMapper.ts` — maps “thinking/effort” style settings into provider-specific knobs.
- `CacheManager.ts` — caching utilities for LLM requests/results (when enabled/appropriate).
- `WebSearchUtils.ts` — helpers used for web-search style flows (if enabled by provider/tooling).
- `index.ts` — exports/barrel for utilities in this folder.

## Improvement Ideas

- Consolidate logging and validation patterns with the rest of the repo (`src/utils/`) to reduce duplication.
- Keep LLM utilities focused on LLM concerns; relocate generic helpers if they become widely used.
- Add small tests for token/cost extraction across providers to prevent regressions.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.

