---
name: nexus-testing
description: How Nexus is tested — Jest unit lanes, env-gated live smoke tests against a real vault, and the methodology rules that came out of defects which shipped past a green suite. Use when adding tests, when a change touches search ranking or tool discovery, when a mock might be hiding a real behaviour, or when deciding whether a unit test can actually prove something.
---

# Nexus Testing

## Lanes

| Lane | How | Scope |
|---|---|---|
| Unit | `npm run test` (Jest) — `tests/unit/` holds 315 of the 346 `*.test.ts` files | Core logic and services |
| Live smoke | env-gated, `--runInBand` | Real vault through the real `nexus` CLI |
| LLM eval | `RUN_EVAL=1`, skills `nexus-model-eval` / `nexus-eval-harness` | Grades two-tool MCP usage |
| Integration | `tests/integration/` (Jest, some live-gated) | Cache backend, migrations, tool continuation |
| Manual | `tests/manual/*.md` — scripts, not Jest | Anything only observable in the running Obsidian app |

Jest config is `roots: ['<rootDir>/tests']` + `testMatch: ['**/*.test.ts']`, so
`npm run test` picks up **every** lane; the live smoke tests make themselves inert
with `describe.skip` and `eval.test.ts` degrades to a single "skips — no API keys
configured" case unless the gate is set. Other directories under `tests/`:
`integration` (11), `debug` (5), `eval` (3, of which the executor-recovery and
`headless/` smoke tests always run), `core` (2), `agents/*` (7), `services/*` (2),
`perf` (1). `npm run test:coverage` runs Jest with a global 80% threshold.

## The core lesson: a green suite is not proof

Three search-ranking defects (#309, #313, #314) shipped past a green unit suite.
Every one was caught by searching a real vault. The suite could only prove the tiers
were ordered consistently *with a mocked scorer* — it could not know whether real
filenames look like the fixtures, or whether real Obsidian scores the way the mock
does.

Two habits follow.

### Ask what the mock is deciding

If a mock supplies the values the assertion depends on, the test proves the mock is
self-consistent and nothing more. Two live examples worth knowing:

- **`prepareFuzzySearch` mock** (`tests/mocks/obsidian/core.ts`) charges a small
  per-discontiguity penalty **capped at 8**. That cap reproduces the reason the
  original bug existed. **Do not make it proportional** — the tests go vacuous.
- **A scenario-scripted `getTools` mock is selector-insensitive** — a scenario's
  `mockResponses` entry becomes a handler built by `registerStaticResponse`
  (`tests/eval/EvalToolExecutor.ts`), whose body ignores its `_args` and returns the
  same blob for every call. A scenario exposing only some agents makes a model
  conclude discovery is broken and loop `getTools` forever at temperature 0. Expose
  every agent a scenario could plausibly need. (Only the scripted path is blind: with
  no scripted mock, `handleGetTools` auto-generates schemas and *does* filter
  `domainTools` by the requested selectors.)

### Prove the ordering isn't accidental

`tests/unit/SearchContentTool.test.ts` routes every ranking assertion through a
`rank()` helper that executes the tool **twice** — once with the fixtures forwards,
once with `[...files].reverse()` — and throws if the two result orders differ. A tie
is not a ranking rule. The helper is the only way the tests obtain results, so the
guarantee cannot be bypassed by adding a case; a self-test at the bottom of the file
asserts the helper actually rejects a tie (`/decided by enumeration order/`). Apply
the same treatment anywhere enumeration order could masquerade as ranking.

## Live smoke lanes

Pattern to copy — `tests/debug/search-ranking-live-smoke.test.ts`:

```
RUN_SEARCH_SMOKE=1 npx jest tests/debug/search-ranking-live-smoke.test.ts --runInBand --no-coverage
```

Conventions: env-gated (`describe.skip` unless `RUN_SEARCH_SMOKE === '1'`) so the
lane is inert by default and never a CI dependency; `--runInBand`; a header
explaining what the mocks cannot cover; writes confined to a dedicated scratch folder
(`_search-ranking-smoke`) which `afterAll` clears with `storage archive` — archive,
not delete, because the AI surface has no delete by design; never touches anything
else in the vault. `SEARCH_SMOKE_VAULT=<name>` picks a vault, otherwise the CLI
default is used.

Other live lanes and their gates:

| Test | Gate |
|---|---|
| `tests/debug/provider-model-live-smoke.test.ts` | `RUN_MODEL_SMOKE=1` |
| `tests/debug/video-generation-live-smoke.test.ts` | `RUN_LIVE_VIDEO_SMOKE=1` (+ `RUN_PAID_VIDEO_SMOKE=1` for paid calls) |
| `tests/debug/codex-live-tool-pingpong.test.ts` | `RUN_CODEX_LIVE_TOOL_PINGPONG=1` + live tokens |
| `tests/debug/intelligence-curse-repro.test.ts` | presence of a JSONL fixture (`DEBUG_REPRO_JSONL`) |
| `tests/integration/transcription-live.test.ts` | `RUN_LIVE_TRANSCRIPTION_TESTS=1` + per-provider API keys |
| `tests/integration/tool-continuation-live.test.ts` | `OPENROUTER_API_KEY` present |

## Search ranking invariant

`src/agents/searchManager/tools/searchContent.ts` is a **single-scale tier ladder**:

```
TITLE_EXACT_SCORE 0.95 > EXACT_PHRASE_SCORE 0.9 > ALL_WORDS_SCORE 0.8
> PARTIAL_MATCH_FLOOR 0.3 > FUZZY_ONLY_CEILING 0.25
```

**Never reintroduce a second scale.** Filename fuzzy used to be normalized to
`1 + score/100` (~0.92–0.95), an incommensurable scale that let a coincidental
filename beat a verbatim body match. `foldSeparators()` lowercases and folds runs of
`-`/`_` to single spaces, and is applied to **both sides of the filename comparison**
(the query and the filename) so a kebab filename matches a spaced query — never to
note bodies, which stay byte-exact so the snippet offsets keep pointing at real text.
Results carry `matchType`, whose type is
`export type SearchMatchType = 'content' | 'path' | 'semantic'`; the tool assigns
`content` when the body scored above zero, otherwise `path`.

## Eval harness knobs

`tests/eval/`, plan at `docs/plans/llm-eval-harness-plan.md`.

| Knob | Effect |
|---|---|
| `RUN_EVAL=1` | Required to run at all — and at least one provider must have its key env var set, or the suite still skips |
| `EVAL_SCENARIO_NAMES=a,b,c` | Targeted retest (comma-separated, overrides `config.scenarioNames`) |
| `EVAL_CONCURRENCY=N` | Override the dispatch width. **The default is per-matrix, not a flat 1**: `resolveConcurrency` returns `1` only when a local provider (`ollama`, `lmstudio`) is in the matrix, otherwise `Infinity`. Local single-slot servers 500-storm under fan-out |
| `EVAL_TEMP` | Overrides `defaults.temperature` (per-scenario `temperature:` still wins) |
| `EVAL_TEST_TIMEOUT_MS` | Jest timeout; the computed default scales the per-case budget by the estimated serial lane count |
| `EVAL_ENFORCE_CONTEXT=1` | Enforces the context contract globally (a scenario can also opt in with `enforceContextContract: true`) |

Per-case progress streams to `<artifactsDir>/eval-progress-<ISO-timestamp>.log`
(`artifactsDir` defaults to `test-artifacts/`) — `tail -f`-able during a slow local
run. Results are pushed into `allResults` incrementally as each scenario finishes,
and `afterAll` saves whatever is there, so a mid-run timeout still produces JSON + MD.
Scenarios with known fixture bugs can set `excludeFromBoard: true`; the runner stamps
`excludedFromBoard` on the result and `ReportGenerator` runs and reports them but
skips them when scoring the board.

## Shipped-docs gate

`tests/unit/shippedGuidanceCommands.test.ts` validates every tool command we ship as
guidance against the generated catalog `cli-first-tool-schemas.json` (repo root). It
reads `README.md`, `skill/SKILL.md`, `cli/nexus-cli.ts`, `cli/agents-snippet.md`,
`skill/playbooks/*.md` and `guide/*.md`, and fails on: an unknown agent, tool or
flag; a playbook `tools:` selector that resolves to nothing; a tool named in the
`guide/apps.md` Apps table that matches no `slug:` declared under `src/agents/**`
(apps are opt-in, so those are checked against source rather than the catalog
snapshot); a missing required argument in a *complete*
copy-pasteable `nexus use … -- <cmd>` example; a broken relative doc link; and an
embedded `--prompts` payload that violates the `executePrompts` item contract.

So if you rename or remove a tool slug, fix the **source** guidance files above —
`src/utils/cliAssets.ts` is generated from `skill/SKILL.md`, `cli/agents-snippet.md`
and the playbooks by `scripts/generate-cli-content.mjs` during `npm run build`, and
must never be hand-edited. Refreshing the catalog needs a running vault (the
`/nexus-tool-schemas` skill); note `npm run schemas:tools` writes to
`docs/generated/cli-first-tool-schemas.json` by default, not the repo-root file this
test reads — pass `--output cli-first-tool-schemas.json` to update that one. A stale
catalog also surfaces as a drift failure in `tests/unit/ToolManagerCliSyntax.test.ts`.
