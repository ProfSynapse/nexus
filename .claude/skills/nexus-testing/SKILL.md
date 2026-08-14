---
name: nexus-testing
description: How to write a Nexus test that can actually fail, pick the right lane, run the live and eval lanes, and fix a shipped-docs drift failure. Use when adding tests, when a mock might be deciding the outcome, when a change touches search ranking or tool discovery, or when the guidance gate fails.
---

# Testing Nexus

## Pick the lane

| Lane | Where | For |
|---|---|---|
| Unit | `tests/unit/` | Logic that can be proven with fakes |
| Integration | `tests/integration/` | Cache backend, migrations, tool continuation |
| Live smoke | `tests/debug/` | Behaviour only the real dependency exhibits |
| LLM eval | `tests/eval/` | How well a model drives the two-tool protocol |
| Manual | `tests/manual/*.md` | Scripts for what only the running app shows |

Jest is configured with `roots: ['<rootDir>/tests']` and `testMatch: ['**/*.test.ts']`,
so `npm run test` picks up **every** lane. The live and eval lanes make themselves
inert when their gate is unset — that is a property of each test file, not of the
runner, so a new live test must opt out explicitly or it will run in CI.

## Write a test that can actually fail

Three ranking defects shipped past a green suite. Every one was caught by searching
a real vault. The suite could only prove the tiers were ordered consistently *with a
mocked scorer* — it could not know whether real data looks like the fixtures.

Two habits follow.

**Ask what the mock is deciding.** If the mock supplies the values your assertion
depends on, the test proves the mock is self-consistent and nothing more. Before
writing the assertion, ask: if the real dependency behaved differently, would this
test notice? If not, the test belongs in a live lane, or the mock needs to reproduce
the *shape* of the real behaviour — including the part that caused the bug.

**Prove the ordering is not accidental.** Anywhere enumeration order could
masquerade as ranking, run the assertion twice with the input order reversed and
fail if the two results differ. `tests/unit/SearchContentTool.test.ts` does this
through a `rank()` helper that is the only way the tests obtain results, so the
guarantee cannot be bypassed by adding a case — and a self-test at the bottom
asserts the helper really does reject a tie. Copy that structure rather than
remembering to reverse by hand.

## Add a live smoke lane

Copy `tests/debug/search-ranking-live-smoke.test.ts`. The conventions exist because
a live lane touches a real vault:

1. **Gate it** — `describe.skip` unless its env var is set, so it is inert by
   default and never a CI dependency
2. **`--runInBand`** — live lanes are not safe to parallelise
3. **Header comment** stating what the mocks cannot cover, so the next person knows
   why the lane exists
4. **Confine writes** to a dedicated scratch folder and clean up in `afterAll` —
   note the existing lane clears its folder with `storage archive`, not delete,
   because the AI surface has no delete by design
5. **Touch nothing else in the vault**

Run it explicitly:

```bash
RUN_SEARCH_SMOKE=1 npx jest tests/debug/search-ranking-live-smoke.test.ts --runInBand --no-coverage
```

Each live lane has its own gate variable — read the file's header rather than
assuming; several also need provider keys or a fixture path.

## Run the eval harness

`RUN_EVAL=1`, plus at least one provider key, or the suite skips. Full guidance is
in the `nexus-model-eval` and `nexus-eval-harness` skills; the knobs that change
behaviour rather than scope are `EVAL_SCENARIO_NAMES` (targeted retest),
`EVAL_CONCURRENCY`, `EVAL_TEMP`, `EVAL_TEST_TIMEOUT_MS` and `EVAL_ENFORCE_CONTEXT`.

**Concurrency is per-matrix, not a flat serial.** `resolveConcurrency` returns 1
only when a local provider (`ollama`, `lmstudio`) is in the matrix; every other
matrix fans out fully. Local single-slot servers 500-storm under fan-out, which is
what that special case exists to prevent — so do not "fix" a slow cloud run by
forcing serial, and do not expect a local run to behave like a cloud one.

Results are pushed in as each scenario finishes and `afterAll` saves whatever is
there, so a mid-run timeout still produces reports. Per-case progress streams to a
log under the artifacts dir — `tail -f` it during a slow local run rather than
waiting for the summary.

## Fix a shipped-docs drift failure

`tests/unit/shippedGuidanceCommands.test.ts` validates every tool command in shipped
guidance against the repo-root `cli-first-tool-schemas.json`. It fails on an unknown
agent/tool/flag, a playbook selector resolving to nothing, a missing required
argument in a complete copy-pasteable example, a broken relative doc link, and an
embedded `--prompts` payload violating the item contract.

When it fails, the fix is in one of two places and it matters which:

- **The docs are wrong** → edit the *source* guidance (`skill/SKILL.md`,
  `cli/agents-snippet.md`, `skill/playbooks/*.md`, README, `guide/*.md`). Never edit
  `src/utils/cliAssets.ts` — it is generated from those sources during the build.
- **The catalog is stale** → refresh it. Regenerating needs a running vault (the
  `nexus-tool-schemas` skill). `npm run schemas:tools` writes
  `docs/generated/cli-first-tool-schemas.json` by default, **not** the repo-root file
  this test reads — pass `--output cli-first-tool-schemas.json`.

A stale catalog also surfaces as a drift failure in
`tests/unit/ToolManagerCliSyntax.test.ts`, so two failures with one cause is the
expected signature.

## Gotchas

**"I fixed the docs and the gate still fails."** You regenerated to
`docs/generated/`. The gate reads the repo-root catalog.

**"My change to `cliAssets.ts` disappeared."** It is generated during the build.

**"The eval model looped `getTools` forever."** A *scenario-scripted* mock is
selector-insensitive: `registerStaticResponse` builds a handler that discards its
args and returns the same blob for every call. A scenario exposing only some agents
makes the model conclude discovery is broken. Expose every agent the scenario could
plausibly need. Only the scripted path is blind — with no scripted mock, discovery
does filter by the requested selectors, so do not misdiagnose the auto-generated
path this way.

**"Ranking looks right locally and wrong in the vault."** The fuzzy-search mock
charges a bounded per-discontiguity penalty, and the bound is what reproduces the
original bug. Do not make it proportional — the tests go vacuous and stop
distinguishing the tiers.

**"I added a scoring rule and everything still passes."** Read the tier constants in
`src/agents/searchManager/tools/searchContent.ts` before adding one. The ladder is a
**single scale**; the original defect was a second, incommensurable scale for
filename fuzzy that let a coincidental filename outrank a verbatim body match. Any
new score must be placed on the existing ladder.

**"My filename normalisation broke snippet offsets."** Separator folding applies to
both sides of the *filename* comparison only. Note bodies stay byte-exact so snippet
offsets keep pointing at real text.

**"The live test ran in CI."** Its gate is missing or inverted. Live lanes must be
inert without their env var.
