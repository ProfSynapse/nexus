# RequestUrl-First Provider Migration Plan

## Summary

- Replace provider-stack SDK, `fetch()`, and Node `https` usage with a shared `requestUrl` transport.
- Preserve the adapter-facing API so `LLMService`, `StreamingOrchestrator`, and settings UI do not need a second codepath.
- Treat remote cloud providers as mobile-compatible once they only depend on the shared HTTP layer.
- Use buffered streaming replay for `requestUrl`-backed providers because Obsidian `requestUrl()` is fully buffered in the current API.

## Implemented Changes

- Added shared transport in `src/services/llm/adapters/shared/ProviderHttpClient.ts`.
- Added buffered SSE replay in `src/services/llm/streaming/BufferedSSEStreamProcessor.ts`.
- Extended provider capability metadata with optional `streamingMode`.
- Migrated provider-stack HTTP callers off direct `fetch()`/Node `https`:
  - OAuth providers
  - validation service
  - token counting helpers
  - OpenRouter, Requesty, Perplexity, Ollama, LM Studio
  - OpenAI Codex
  - OpenAI, Anthropic, Mistral, Groq, Google text adapters
  - OpenAI and Google image adapters
- Updated mobile compatibility and adapter initialization so remote cloud providers can initialize on mobile while `openai-codex`, `ollama`, `lmstudio`, and `webllm` remain desktop-only.
- Removed obsolete `nodeFetch` transport and SDK dependency declarations from `package.json`.

## Test Coverage

- Added unit coverage for the shared request client.
- Added unit coverage for buffered SSE replay.
- Added unit coverage for mobile provider compatibility gating.
- Replaced the old Codex adapter transport test coverage with a `requestUrl`-based suite aligned to the new architecture.

## Follow-Up Checks

- Manual smoke test desktop chat/tool flows across OpenAI, Anthropic, Google, OpenRouter, and Codex.
- Manual smoke test mobile chat flows for OpenAI, Anthropic, Google, Mistral, Groq, OpenRouter, Requesty, and Perplexity.
- After dependency reinstall, verify lockfile/package manager state reflects removed SDK packages.
