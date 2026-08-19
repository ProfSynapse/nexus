# Harness map

Context: read this before changing anything under `tests/eval/`, or when a
result makes no sense and you need to know which file decided it. It says what
each piece owns and how one run is assembled. It deliberately names no
scenarios, configs or models — those come from the tree.

## Key idea

One eval job is `(provider, model, scenario)`. The harness builds the job list,
hands each job to the **production** streaming path with a fake tool executor
underneath, captures every tool call that path executes, and compares the
capture to the scenario's expectations. Nothing about the model's prose is
graded — only the calls.

## The path a job takes

1. `eval.test.ts` — the Jest entry point. Loads the config, resolves enabled
   providers, loads scenarios, builds the job matrix, decides concurrency and
   the test timeout, and writes the reports.
2. `ConfigLoader.ts` — turns a YAML config (or the built-in default) plus env
   overrides into one `EvalConfig`. It also reads the repo-root `.env`.
3. `SchemaCatalog.ts` — resolves `schemaVersion` through
   `<repo>/schemas/manifest.json`, loads the generated MCP surface and the advertised
   subset of the generated CLI catalog, and converts them for the executor.
4. `ScenarioLoader.ts` — reads `*.eval.yaml` under the configured glob. Each
   file must be a **list** of scenarios; an entry without `name` or `turns` is
   skipped with a console warning and no other trace.
5. `EvalRunner.ts` — runs one job: groups turns into exchanges, creates the tool
   executor, builds a `StreamingOrchestrator` over a real provider adapter, runs
   one `generateResponseStream` per exchange, then asserts.
6. `EvalToolExecutor.ts` (mock) or `LiveToolExecutor.ts` (live) — implements the
   same `IToolExecutor` the app uses, so the orchestrator cannot tell the
   difference.
7. `assertions.ts` — the graders: expected calls per round, the meta-arg
   contract, and the hallucination check.
8. `ReportGenerator.ts` — markdown and JSON reports, including the resolved
   schema release.

Supporting pieces: `fixtures/tools.ts` (loads the versioned schemas the model and the mock
executor share), `fixtures/system-prompt.ts` (builds the **production** system
prompt through `SystemPromptBuilder`), `RequestCapture.ts` (raw HTTP dumps on
failure), `EvalAdapterRegistry.ts`, `types.ts` (the scenario and config
contract), and `headless/` (a real agent stack on a filesystem vault, used by
live mode).

## The surface the model sees is always the two-tool surface

`eval.test.ts` resolves the tool set with a hardcoded `'meta'`. Every job hands
the model `getTools` and `useTools` and nothing else, regardless of what a
scenario's `toolSet` says. `toolSet` survives only as a **filter key** for the
`EVAL_TOOL_SET` config/env filter. A scenario that expects a domain tool such as
`contentManager_read` still passes: the executor unwraps the `useTools` CLI
string and captures the inner call under that name.

## Mock mode versus live mode

| | mock | live |
|---|---|---|
| tool results | scripted by the scenario, or synthesised | produced by real agents |
| vault | none | a per-job directory under `testVaultPath`, gitignored |
| `seedFiles` | ignored | seeded, plus files inferred from `mockResponses` payloads that carry a `path` + `content` pair |
| agents available | advertised tools selected from the versioned CLI catalog | only what `headless/HeadlessAgentStack.ts` registers |
| what it proves | tool *invocation* | invocation plus real execution |

Live mode registers a fixed, short list of agents (read the file — it is the
authority) with vector search off. A scenario that needs an agent the headless
stack never constructs cannot pass in live mode, and the failure looks like a
model failure in the report. Live is also not the app: Jest maps every
`obsidian` import to the repo's hand-written mock in every lane, this one
included, so agent code that leans on Obsidian's own helpers is graded against
the mock's behaviour.

## Model-free coverage that already exists

Two suites exercise the harness itself with no API key and no network, in the
ordinary Jest lane:

```bash
npx jest tests/eval/EvalToolExecutorRecovery.test.ts tests/eval/headless --no-coverage
```

`EvalToolExecutorRecovery.test.ts` pins the mock executor's context-contract
steering, recovery accounting and sequential-response semantics.
`headless/headless.smoke.test.ts` pins the real agent stack behind live mode.
Extend these when you change the executors — they fail in seconds, where a live
matrix costs money and minutes.

## Deriving current truth

```bash
ls tests/eval/                              # the pieces above, as they are now
sed -n '/export interface EvalScenario/,/^}/p' tests/eval/types.ts   # scenario fields
grep -n "export const" tests/eval/fixtures/tools.ts                  # tool sets
grep -rn "createHeadlessAgentStack" -A 20 tests/eval/headless/HeadlessAgentStack.ts | head -40
```
