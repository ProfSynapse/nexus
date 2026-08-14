---
name: nexus-testing
description: How Nexus is tested — Jest unit lanes, env-gated live smoke tests against a real vault, and the methodology rules that came out of defects which shipped past a green suite. Use when adding tests, when a change touches search ranking or tool discovery, when a mock might be hiding a real behaviour, or when deciding whether a unit test can actually prove something.
---

# Nexus Testing

## Lanes

| Lane | How | Scope |
|---|---|---|
| Unit | `npm run test` (Jest, ~346 files under `tests/`) | Core logic and services |
| Live smoke | env-gated, `--runInBand` | Real vault through the real `nexus` CLI |
| LLM eval | `RUN_EVAL=1`, skills `nexus-model-eval` / `nexus-eval-harness` | Grades two-tool MCP usage |
| Integration | Manual in Obsidian | Anything only observable in the running app |

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
- **The scripted `getTools` mock in the eval harness is selector-insensitive** — it
  returns the same blob for every call. A scenario exposing only some agents makes a
  model conclude discovery is broken and loop `getTools` forever at temperature 0.
  Expose every agent a scenario could plausibly need.

### Prove the ordering isn't accidental

`tests/unit/SearchContentTool.test.ts` runs every ranking assertion **twice**, with
the vault enumerated in both orders, and fails loudly if the order decides the
result. A tie is not a ranking rule. Apply the same treatment anywhere enumeration
order could masquerade as ranking.

## Live smoke lanes

Pattern to copy — `tests/debug/search-ranking-live-smoke.test.ts`:

```
RUN_SEARCH_SMOKE=1 npx jest tests/debug/search-ranking-live-smoke.test.ts --runInBand --no-coverage
```

Conventions: env-gated so the lane is inert by default and never a CI dependency;
`--runInBand`; a header explaining what the mocks cannot cover; writes confined to a
dedicated scratch folder and cleaned up afterwards; never touches anything else in
the vault.

Other live lanes live beside it in `tests/debug/` (provider model smoke, video
generation, codex ping-pong).

## Search ranking invariant

`src/agents/searchManager/tools/searchContent.ts` is a **single-scale tier ladder**:

```
TITLE_EXACT_SCORE 0.95 > EXACT_PHRASE_SCORE 0.9 > ALL_WORDS_SCORE 0.8
> PARTIAL_MATCH_FLOOR 0.3 > FUZZY_ONLY_CEILING 0.25
```

**Never reintroduce a second scale.** Filename fuzzy used to be normalized to
`1 + score/100` (~0.92–0.95), an incommensurable scale that let a coincidental
filename beat a verbatim body match. `foldSeparators()` folds `-`/`_` to spaces on
both sides so a kebab filename matches a spaced query. Results carry
`matchType: 'content' | 'path' | 'semantic'`.

## Eval harness knobs

`tests/eval/`, plan at `docs/plans/llm-eval-harness-plan.md`.

| Knob | Effect |
|---|---|
| `EVAL_SCENARIO_NAMES=a,b,c` | Targeted retest |
| `EVAL_CONCURRENCY` | **Defaults to serial=1** — local single-slot servers 500-storm under fan-out |
| `EVAL_TEMP` | Overrides default temperature (per-scenario `temperature:` still wins) |
| `EVAL_TEST_TIMEOUT_MS` | Jest timeout; scales with serial lane count |
| `EVAL_ENFORCE_CONTEXT=1` | Enforces the context contract |

Per-case progress streams to `test-artifacts/eval-progress-<ts>.log`, and reports
save incrementally so a mid-run timeout still produces JSON + MD. Scenarios with
known fixture bugs can set `excludeFromBoard: true` to run without scoring.

## Shipped-docs gate

`tests/unit/shippedGuidanceCommands.test.ts` fails when shipped guidance names a
tool that does not exist. If you rename or remove a tool slug, that test is where it
surfaces — update the shipped guidance in `src/utils/cliAssets.ts` and regenerate
schemas with `npm run schemas:tools`.
