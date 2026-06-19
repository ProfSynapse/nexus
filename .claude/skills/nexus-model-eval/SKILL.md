---
name: nexus-model-eval
description: Grade LLM models on Nexus tool-use (the two-tool getTools/useTools protocol) with the live eval harness in tests/eval/. Use when asked to grade, benchmark, or evaluate one or more OpenRouter (or other provider) models for how well they drive Nexus tools — e.g. "grade google/gemma-4-31b-it" or "benchmark these models on our harness".
---

# Nexus Model Eval

Grade how well a model uses the Nexus tools via the eval harness at `tests/eval/`. The harness presents the model the **real two-tool surface** (`getTools`/`useTools`), runs each scenario through the production streaming + tool-continuation path, and grades the captured tool calls (right tool? right args? right sequence?).

The output is a **binary pass/fail per scenario** and an overall pass rate per model. A scenario passes only if every turn's tool-call assertions pass with zero hallucinated tools.

## What this grades (and what it does not)

- **Grades:** does the model discover tools via `getTools`, then call `useTools` with the correct CLI command, kebab-case flags, and correct arguments, in the correct order across turns.
- **Does NOT grade:** whether a tool's backend actually returns useful data. Run in **mock mode** so tool *results* are scripted — we test tool *invocation*, not search relevance or vault state. (Live mode executes real agents but the headless stack can't run Obsidian-only APIs like `prepareFuzzySearch`, which poisons search scenarios. Use mock.)

## Steps

### 1. Pre-flight: verify each model slug resolves on OpenRouter
A full run is expensive; don't burn it on a dead slug. The public models endpoint needs no key:

```bash
models=$(curl -s https://openrouter.ai/api/v1/models)
for m in "google/gemma-4-31b-it" "anthropic/claude-sonnet-4.6"; do
  echo "$models" | grep -q "\"id\":\"$m\"" && echo "FOUND: $m" || echo "NOT FOUND: $m"
done
```

The harness reads `OPENROUTER_API_KEY` from the repo-root `.env` (gitignored) on its own — do **not** try to read `.env` yourself (it's deny-listed). Other providers map by `apiKeyEnv` (ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, etc.).

### 2. Write a scoped config
Create `tests/eval/configs/<label>-<date>.yaml`. Use **mock mode**. Template:

```yaml
mode: mock
testVaultPath: tests/eval/test-vault/

providers:
  openrouter:
    apiKeyEnv: OPENROUTER_API_KEY
    models:
      - google/gemma-4-31b-it
      - google/gemma-4-26b-a4b-it
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

Note: `scenario.toolSet` in the yaml files is **ignored for the model's tool surface** — the harness always presents the two-tool `meta` surface (`tests/eval/eval.test.ts`, `resolveToolSet('meta')`). It only matters as an `EVAL_TOOL_SET` filter key.

### 3. Run

```bash
mkdir -p test-artifacts
RUN_EVAL=1 EVAL_CONFIG=tests/eval/configs/<label>-<date>.yaml \
  npx jest tests/eval/eval.test.ts --runInBand --no-coverage 2>&1 | tail -5
```

- `RUN_EVAL=1` is required or the suite trivially skips.
- ~5–30s per scenario (LLM is called live); 19 scenarios × N models.
- Run it in the background (`run_in_background: true`) — it's long. The reports are the deliverable, not stdout.
- **jest may report the suite "failed" even on a good run** — a model that loops `getTools` can push one scenario to minutes and brush the test's `testTimeoutMs`, or jest exits non-zero when scenarios fail. **The per-model report files are the source of truth, not jest's exit code.** If a single scenario routinely blows the budget, raise `defaults.timeout` is the wrong lever — raise the test budget in `eval.test.ts` (`testTimeoutMs`) or treat the long-pole scenario as a finding.

### 4. Read the per-model reports
Saved to `test-artifacts/eval-report-<provider>-<model>-<timestamp>.md`:

```bash
for f in $(ls -t test-artifacts/eval-report-openrouter-*-<timestamp>.md); do
  echo "== $f =="
  grep -E "^- (Total scenarios|Pass|Fail):" "$f"
  sed -n '/## Results Summary/,/## Failures/p' "$f" | grep "| FAIL |"
done
```

Each report has a Results Summary table, a Failures section (per-turn errors + response snippet + actual tool-call args), and a Metrics block with the pass rate.

### 5. Interpret honestly
For each FAIL, read the actual calls and decide: **genuine model error vs. harness artifact.** A scenario where the model produced the correct final answer and correct `useTools` args but still failed is almost always a harness issue, not the model. Known-good signals after the harness fixes below: correct `getTools`→`useTools` flow, kebab-case flags (`--start-line` not `--startLine` — both are tolerated, the model self-corrects), correct domain args. Common **genuine** failures: not chaining a required second step (search → read), looping `getTools` without converging, asking to clarify instead of acting on a vague prompt.

Report raw pass rate **and** a one-line note on what the residual failures actually are.

## Harness fidelity — fixes already landed

The harness was made app-faithful (2026-06-18). If grades look implausibly low, check these didn't regress:

1. **Two-tool surface always presented** (`eval.test.ts` → `resolveToolSet('meta')`). The model must get `getTools`/`useTools`, never raw domain tools.
2. **Mock executor parses CLI flags into args** (`EvalToolExecutor.parseCliArgs`). It previously returned `args: {}`, failing every unwrapped domain call on "missing param."
3. **Synthetic markers excluded from hallucination check** (`assertions.ts` — names wrapped in `__…__` like `__cli_parse_error__` are executor artifacts, not model tool calls).
4. **Search tool names in scenarios match production slugs** (`content`/`directory`/`memory`, i.e. `searchManager_content` and CLI `search content` — NOT `searchManager_searchContent`/`search search-content`). Real slugs come from each tool's `BaseTool` constructor first arg (`src/agents/searchManager/tools/*.ts`).

If you add a model permanently, also list it in a shared config (e.g. `tests/eval/configs/model-sweep-*.yaml`).
