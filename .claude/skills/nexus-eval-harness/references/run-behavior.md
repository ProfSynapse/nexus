# Run behavior

Context: read this when configuring a run, or when a finished run produced
numbers, files or timings you cannot explain. It covers how a config is
resolved, how the matrix is dispatched, and what each artifact counts.

## Key idea

Almost nothing in a run is what its name suggests: `EVAL_TOOL_SET` does not
choose the tool surface, retries apply to *behavioural* failures, concurrency is
not a flat serial, and the timeout is for the whole matrix. Each of these has
made someone mis-read a result.

## How a config is resolved

`EVAL_CONFIG` names a YAML file; without it, a built-in default config applies.
Missing keys in a YAML file fall back to that default, not to nothing. Then env
overrides are layered on top.

Two things about the env layer:

- **Values come from `process.env` *or* the repo-root `.env`.** A stale
  `EVAL_MODE` or `EVAL_TARGETS` left in `.env` silently redirects every run.
  When a run does not match its config, check `.env` before anything else. Do
  not print it; it holds API keys.
- **Target overrides replace the whole providers block.** Setting
  `EVAL_TARGETS='provider=model,...'` (or `EVAL_PROVIDER` together with
  `EVAL_MODELS` — either alone throws) discards the config file's providers
  entirely rather than adding to them. A provider named this way needs a known
  API-key env var, either from the config's providers block or the loader's
  built-in map, or the run throws.

Provider selection then drops any provider whose key env var is unset, with a
console warning. If that leaves none, the suite prints a skip notice and
**passes** — a green suite that ran zero models.

`RUN_EVAL=1` is required as well; without it the suite skips by design so an
ordinary `npm run test` cannot bill a provider.

Local providers (`ollama`, `lmstudio`) are keyless and point at a localhost
OpenAI-compatible endpoint (`OLLAMA_BASE_URL` / `LMSTUDIO_BASE_URL`). Note that
an `ollama` target is driven through the **LM Studio** adapter against Ollama's
OpenAI-compatible route, not through the Nexus Ollama adapter — so a local grade
does not exercise the adapter a user on Ollama actually runs. (The in-file
justification for that detour is out of date; the Ollama adapter now reports
function support. Treat the routing as the fact and the reason as unverified.)

## The tool-set filter is a filter

`EVAL_TOOL_SET` (and `scenarioToolSet` in a config) selects **which scenarios
run**, by comparing against each scenario's `toolSet` (default `meta`). It does
not change what the model sees; that is always the two-tool surface. Set it to
`all` — the built-in default — to run everything.

`EVAL_SCENARIOS` re-points the glob and also accepts a single file path.
`EVAL_SCENARIO_NAMES` narrows to specific scenario `name` values, which is the
cheap way to iterate on one fixture.

## Retries can hide a behavioural failure

The retry loop is not only for transport errors. A scenario whose *assertions*
failed is retried too, up to `maxRetries`; only a turn that failed exclusively
with non-retryable stream errors fails fast. So `maxRetries: 1` gives a model
two attempts at getting the tool calls right, and the run reports a pass.

The report records `retryCount` per scenario. Read it. When you want a clean
behavioural measurement, set retries to 0 and accept that transient 429s become
failures; when you want throughput, leave retries on and discount any pass that
needed one.

## Concurrency and timeout

- `EVAL_CONCURRENCY` wins if set. Otherwise the matrix runs **fully parallel**
  unless a local provider is in it, in which case it runs serially — local
  single-slot servers 500-storm under fan-out. Do not "fix" a slow cloud run by
  forcing serial.
- The Jest per-test timeout has to cover the *entire* matrix, so it is computed
  from the per-case budget scaled by the number of serial lanes. Override with
  `EVAL_TEST_TIMEOUT_MS` rather than shrinking the matrix to fit. Raising
  `defaults.timeout` raises the per-case budget, not the test budget.

## Artifacts, and which one is the truth

Everything lands under the configured artifacts dir (gitignored):

| file | when it is written |
|---|---|
| `eval-progress-<stamp>.log` | appended as each job finishes; the run prints its path at the start |
| `eval-report-<provider>-<model>-<stamp>.md` / `.json` | after the whole matrix resolves |
| `eval-report-<stamp>.md` / `.json` | in `afterAll`, covering every result recorded so far |
| `traces/eval-trace-<job>-<ms>.jsonl` | only with `EVAL_TRACE_STREAM=1`: chunks, tool calls, tool events, assertions |
| request-capture dumps | on failure, when capture is enabled |

Results are pushed into the accumulator as each job finishes, so **a mid-run
timeout still produces the combined report** — but not the per-model ones, which
are written after the matrix resolves. Jest buffers stdout in non-TTY runs;
`tail -f` the progress log instead of waiting for the summary.

Jest may report the suite failed while the run was fine: a failing scenario is a
failing expectation, and a matrix that brushes the test timeout aborts the test
body after the reports were already accumulated. The saved reports are the
verdict.

## What the numbers count

- The **markdown Metrics block** counts every result, including scenarios
  flagged `excludeFromBoard`.
- The **JSON `byModel` rollup** excludes them, and is the leaderboard-shaped
  number.

Those two therefore disagree by design whenever a quarantined scenario is in the
run. Quote the JSON `byModel` rate for model comparisons, and say which one you
used. Interpreting those rates as model quality belongs to `nexus-model-eval`.

## The system prompt is production's, with one hand-maintained edge

`systemPrompt: default` builds the real prompt through the production
`SystemPromptBuilder`, so prompt changes reach the harness automatically.
`minimal` uses a small constant, and any other string is used literally as the
prompt.

The tool catalog fed to that builder in `fixtures/system-prompt.ts` is a
hand-maintained list, and it is the one place the harness can silently drift
from the real agent registry. If a model is told about an agent that no longer
exists — or is never told about one that does — check that list against the live
catalog (`nexus-tool-schemas`).
