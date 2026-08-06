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

### Thinking-Mode Token Budget

The smoke test default `MODEL_SMOKE_MAX_TOKENS=16` is calibrated for non-reasoning models that emit a short "OK" echo. **Reasoning/thinking-capable models (Gemini 3.x, Claude with extended thinking, OpenAI reasoning models) will return empty completions at this budget** because the budget is exhausted on internal reasoning tokens before any visible text is emitted.

When testing a model with `supportsThinking: true`, raise the budget:

```bash
RUN_MODEL_SMOKE=1 MODEL_SMOKE_MAX_TOKENS=4096 \
  MODEL_SMOKE_PROVIDER=openrouter MODEL_SMOKE_MODEL=google/gemini-3.5-flash \
  npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage --verbose
```

If a smoke test fails with empty `response.text` on a thinking-capable model, suspect token starvation before suspecting the model ID or API key.

### Google Provider Env Var

The Google direct adapter reads `GEMINI_API_KEY` only — there is **no** `GOOGLE_API_KEY` fallback. If you see "GEMINI_API_KEY is required for Google smoke tests", set that exact var.

### Worktree `.env` Access

The smoke test reads `.env` from `process.cwd()`, not by walking up the directory tree. When running from a git worktree (e.g., `claudesidian-mcp-wt/<feature>/`), the worktree has no `.env` of its own. Two options:

1. **Symlink** (preferred — no harness modification):
   ```bash
   ln -s /Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.env \
         /Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp-wt/<feature>/.env
   ```
2. **Export the env vars inline** before invoking jest.

Do NOT modify the harness to walk up the tree — that path has been flagged by the credential classifier as bypassing user deny rules. The symlink is the canonical workaround.

## Run Against the Eval Harness (Tool-Calling Validation)

**Smoke test is necessary but not sufficient.** It only confirms the model returns text — it does NOT exercise tool calling, multi-turn flows, or any Nexus agent behavior. Before declaring a new model ready, run the LLM eval harness (`tests/eval/`), which drives the model through real Nexus tool schemas against a TestVault.

### Step 1 — Add a config

Create `tests/eval/configs/<model-slug>.yaml` mirroring `live.yaml` with only the new model. Example (`gemini-3.5-flash.yaml`):

```yaml
mode: live
testVaultPath: tests/eval/test-vault/

providers:
  openrouter:
    apiKeyEnv: OPENROUTER_API_KEY
    models:
      - google/gemini-3.5-flash
    enabled: true

defaults:
  temperature: 0
  maxRetries: 1
  retryDelayMs: 2000
  timeout: 120000
  systemPrompt: default

capture:
  enabled: true
  dumpOnFailure: true
  artifactsDir: test-artifacts/

scenarios: tests/eval/scenarios/**/*.eval.yaml
```

Use `openrouter` for cross-provider parity (it routes to the upstream model with a unified API surface). For provider-specific behavior (e.g., Google direct adapter quirks), add a second config pointing at the direct provider.

### Step 2 — Run the harness

```bash
RUN_EVAL=1 EVAL_CONFIG=tests/eval/configs/<model-slug>.yaml \
  npx jest tests/eval/eval.test.ts --no-coverage --verbose
```

The harness drives 12 scenario files (`tests/eval/scenarios/*.eval.yaml`) covering: adversarial, basic-tool-call, content-operations, debug-multi-turn, multi-turn, provider-parity, search-variations, storage-operations, system-prompt, tool-discovery, two-tool-flow, vague-prompts. Total scenarios: ~27-30. Runtime: ~10-15 min per model.

The eval harness is skipped unless `RUN_EVAL=1` is set.

### Step 3 — Compare against baseline

Known prior-model pass rates (from the model-sweep, useful as a sanity baseline):

| Model | Pass rate |
|---|---|
| Claude Sonnet 4.6 | 97% |
| GPT 5.4-mini | 94% |
| GPT 5.4 | 77% |
| Gemini 3 Flash (the older one) | 46% |

A new model in the **80%+ range** is a healthy candidate for default; **<60%** suggests provider-specific prompt/tool-schema incompatibility that the smoke test would never have caught.

### Step 4 — Decide based on results

- **High pass rate (>80%)**: ship — consider promoting to provider default.
- **Mid pass rate (60-80%)**: ship as opt-in, do NOT change defaults.
- **Low pass rate (<60%)**: investigate failures before merging. Common causes: tool-schema rejection (some models choke on `additionalProperties: false`), context-window mismatch, thinking-mode response format quirks.
- **Empty completions across scenarios**: re-check thinking-mode token budgets in scenario configs, not the smoke-test defaults.

## Final Checklist

Before answering:

- Cite or summarize the primary sources used for model facts.
- Confirm which providers and model IDs were added.
- State whether defaults changed.
- Report static tests, live smoke tests, **and eval harness results** (per-scenario pass/fail tally) and build results.
- Mention any skipped provider or known unsupported model variant.
- For reasoning/thinking models, confirm token budgets were raised in both smoke test and any custom eval config.
