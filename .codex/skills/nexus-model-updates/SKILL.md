---
name: nexus-model-updates
description: Add, update, or verify Nexus LLM provider model definitions. Use when adding newly released models, changing OpenAI/OpenRouter/Codex/GitHub Copilot/Anthropic/Google model metadata, updating provider defaults, or live-testing whether a model ID works through the reusable provider smoke test.
---

# Nexus Model Updates

Use this skill whenever a task changes Nexus model availability, model prices, context windows, capabilities, defaults, or live provider compatibility.

## Research First

Verify new or changed cloud models against primary sources before editing. Prefer official provider docs, model pages, pricing pages, or API model listings. For OpenAI model work, use the `openai-docs` skill or official OpenAI domains. For OpenRouter, use the model page, for example `https://openrouter.ai/openai/<model-id>`.

Capture these facts before editing:

- Provider-facing model ID.
- Display name.
- Context window and max output tokens.
- Input and output price per 1M tokens.
- Whether text, image input, functions/tools, streaming, JSON/structured outputs, and reasoning are supported.
- Whether the model should become the provider default.

## Edit Model Registries

Provider model registries live under:

```text
src/services/llm/adapters/<provider>/<Provider>Models.ts
```

Common files:

```text
src/services/llm/adapters/openai/OpenAIModels.ts
src/services/llm/adapters/openrouter/OpenRouterModels.ts
src/services/llm/adapters/openai-codex/OpenAICodexModels.ts
src/services/llm/adapters/github-copilot/GithubCopilotModels.ts
src/services/llm/adapters/anthropic/AnthropicModels.ts
src/services/llm/adapters/google/GoogleModels.ts
```

For each model, add or update a `ModelSpec` with:

```ts
{
  provider: 'openai',
  name: 'GPT-5.5',
  apiName: 'gpt-5.5',
  contextWindow: 1050000,
  maxTokens: 128000,
  inputCostPerMillion: 5.00,
  outputCostPerMillion: 30.00,
  capabilities: {
    supportsJSON: true,
    supportsImages: true,
    supportsFunctions: true,
    supportsStreaming: true,
    supportsThinking: true
  }
}
```

If changing defaults, update the provider default export in the same file, and update any adapter constructor fallback that hard-codes a default model. Search with:

```bash
rg -n "gpt-|claude-|gemini-|DEFAULT_MODEL|super\\(" src/services/llm/adapters tests
```

OpenRouter model IDs usually include the upstream namespace, for example `openai/gpt-5.5`. The reusable smoke test accepts either `gpt-5.5` or `openai/gpt-5.5` for OpenRouter and normalizes un-namespaced IDs to `openai/<id>`.

Codex OAuth models are defined in `OpenAICodexModels.ts`. Only add models that are available through the Codex/ChatGPT OAuth endpoint. Do not assume a Pro model is available in Codex just because it exists in ChatGPT or the OpenAI API.

## Update Behavior

Some models need code-path updates beyond registry entries:

- OpenAI Pro or long-running Responses API models may need `DeepResearchHandler` routing if streaming chat is unsupported or background polling is recommended.
- OAuth-backed Codex may reject some standard Responses API parameters. The generic live smoke test intentionally omits `maxTokens` for Codex because the endpoint has rejected `max_output_tokens`.
- If a provider adapter has a stale fallback model in its constructor, update it with the same default as the registry.
- If tests assert a previous default model, update those expectations.

## Test Locally

Run focused static tests after changing registries or defaults:

```bash
npx jest tests/unit/ModelRegistry.test.ts tests/unit/OpenAICodexAdapter.test.ts --runInBand
```

Run the build before finishing:

```bash
npm run build
```

If `npm run build` only changes `src/utils/connectorContent.ts` generated timestamp, revert that generated churn unless connector source actually changed:

```bash
git restore -- src/utils/connectorContent.ts
```

## Live Smoke Test

Use the reusable smoke test for arbitrary provider/model checks:

```bash
RUN_MODEL_SMOKE=1 MODEL_SMOKE_PROVIDER=openai MODEL_SMOKE_MODEL=gpt-5.5 npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage --verbose
RUN_MODEL_SMOKE=1 MODEL_SMOKE_PROVIDER=openrouter MODEL_SMOKE_MODEL=gpt-5.5 npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage --verbose
RUN_MODEL_SMOKE=1 MODEL_SMOKE_PROVIDER=openai-codex MODEL_SMOKE_MODEL=gpt-5.5 npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage --verbose
```

Run all provider defaults:

```bash
RUN_MODEL_SMOKE=1 npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage --verbose
```

Provider-specific overrides when running all:

```bash
OPENAI_SMOKE_MODEL=gpt-5.5
OPENROUTER_SMOKE_MODEL=openai/gpt-5.5
CODEX_SMOKE_MODEL=gpt-5.5
```

The live smoke suite is skipped unless `RUN_MODEL_SMOKE=1` is set. In Codex sandboxed sessions, live API calls may fail with DNS or network errors; rerun the same Jest command with escalated permissions when needed.

The smoke test loads OpenAI/OpenRouter API keys from environment variables or repo `.env`, and Codex OAuth tokens from `data.json`. Never print or copy credentials into chat.

## Final Checklist

Before answering:

- Cite or summarize the primary sources used for model facts.
- Confirm which providers and model IDs were added.
- State whether defaults changed.
- Report static tests, live smoke tests, and build results.
- Mention any skipped provider or known unsupported model variant.
