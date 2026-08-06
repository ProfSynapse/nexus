---
name: nexus-eval-harness
description: Run or update the Nexus LLM eval harness for arbitrary provider/model matrices. Use when comparing models in the real vault-like tool environment, changing eval configs, adding eval scenarios, or debugging eval reports.
---

# Nexus Eval Harness

Use this skill for full Nexus model-behavior evals, not simple provider availability checks.

## Core Rule

Use the shared harness in `tests/eval/eval.test.ts`. Do not create one-off runners unless the harness itself is broken and you are actively fixing it.

The harness should run provider/model/scenario jobs in parallel. Avoid sequential loops for model comparisons.

## Production-Like Vault Runs

For the native vault environment, run live mode against the two-tool surface:

```bash
RUN_EVAL=1 EVAL_MODE=live EVAL_TOOL_SET=meta EVAL_TARGETS='openrouter=deepseek/deepseek-v4-pro,openrouter=deepseek/deepseek-v4-flash' npx jest tests/eval/eval.test.ts --runInBand --no-coverage --verbose
```

Notes:

- `--runInBand` only keeps Jest in one worker; the harness runs the eval matrix with `Promise.all`.
- `RUN_EVAL=1` is required so ordinary test runs do not hit live provider APIs.
- `EVAL_TOOL_SET=meta` restricts scenarios to the production `getTools`/`useTools` contract.
- `EVAL_SCENARIO_NAMES` narrows a run to specific scenario names.
- `EVAL_TRACE_STREAM=1` writes per-scenario JSONL traces under `test-artifacts/traces/` as chunks, tool calls, tool events, and assertions arrive.
- API keys are read from process env or repo `.env`; never print credentials.
- Reports are written under `test-artifacts/`.

## Target Selection

Preferred arbitrary target format:

```bash
EVAL_TARGETS='provider=model,provider=model'
```

Examples:

```bash
EVAL_TARGETS='openrouter=anthropic/claude-sonnet-4.6,openrouter=openai/gpt-5.4-mini'
EVAL_TARGETS='openai=gpt-5.4,openrouter=openai/gpt-5.4'
```

Single-provider shorthand:

```bash
EVAL_PROVIDER=openrouter EVAL_MODELS='deepseek/deepseek-v4-pro,deepseek/deepseek-v4-flash'
```

Useful overrides:

```bash
EVAL_CONFIG=tests/eval/configs/live.yaml
RUN_EVAL=1
EVAL_MODE=live
EVAL_SCENARIOS='tests/eval/scenarios/search-variations.eval.yaml'
EVAL_SCENARIO_NAMES='simple-read,replace-content'
EVAL_TOOL_SET=meta
EVAL_TRACE_STREAM=1
EVAL_MAX_RETRIES=3
EVAL_RETRY_DELAY_MS=1000
EVAL_RETRY_BACKOFF_MULTIPLIER=2
EVAL_RETRY_MAX_DELAY_MS=30000
EVAL_TIMEOUT_MS=120000
```

Retry notes:

- The harness retries provider/server failures such as 408, 409, 425, 429, 5xx, timeouts, and transient transport errors with exponential backoff.
- Behavioral scenario failures may still retry up to `maxRetries`, but auth/validation-only stream errors should fail fast.
- Retry delays are per parallel job; one throttled model should not serialize the rest of the matrix.

## Interpreting Results

Separate these failure classes:

- Provider/API failures: stream errors, auth failures, rate limits, transport errors.
- Tool contract failures: missing `workspaceId`, `sessionId`, `memory`, or `goal`; wrong CLI flags; skipped `getTools`.
- Task failures: valid tools called but wrong tool choice, wrong order, or incomplete multi-step plan.
- Harness failures: zero loaded scenarios, non-production tool surface for a vault eval, or leftover generated test vault state.

When the user asks how a model performs “in our environment,” report the `meta` live-run numbers first.
