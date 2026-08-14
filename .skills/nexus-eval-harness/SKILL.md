---
name: nexus-eval-harness
description: Work on the Nexus LLM eval harness in tests/eval/ — author or fix a scenario fixture, write an eval config, change the executors, assertions or reports, or explain a run that produced nothing, everything-fails, or numbers that disagree. Use when an eval scenario is wrong, a run behaves oddly, or the harness itself needs to change. To grade a model rather than change the harness, use nexus-model-eval.
---

# Nexus Eval Harness

Context: the harness under `tests/eval/` drives the **real** production path —
`StreamingOrchestrator` plus tool continuation — with a mock or live tool
executor swapped in, and grades the tool calls a model emits. It is a fixture
system, and almost every surprising result is the fixture talking, not the
model. This skill owns the fixtures, the configs, the executors and the
reports.

## Workflow

1. Pick the job and open its protocol. Work from the protocol; this router
   names procedures, it does not contain them.

   | Job | Protocol |
   |---|---|
   | Add a scenario, or fix one that grades wrongly | `protocols/add-a-scenario.md` |
   | Write or change a config, choose targets, mode, retries | `protocols/configure-a-run.md` |
   | A run produced nothing, all-fails, a hang, or odd numbers | `protocols/debug-a-run.md` |
   | Change the executors, assertions, loader or reports | `protocols/extend-the-harness.md` |

2. Derive every list from the tree, never from this skill. It names no
   scenarios, no configs, no models and no env-var table on purpose, and you
   MUST NOT add one — the harness gains knobs faster than a document survives.

   ```bash
   ls tests/eval/scenarios/ tests/eval/configs/
   grep -rhoE "get(Number|List)?Env\('[A-Z_]+'\)|process\.env\.[A-Z_]+" tests/eval/ \
     | grep -oE "[A-Z][A-Z_]{3,}" | sort -u    # every knob, including the
                                               # ones ConfigLoader mediates
   ```

3. Before calling any scenario change done, run the checker from the repo root
   and fix everything it prints:

   ```bash
   python3 .claude/skills/nexus-eval-harness/scripts/check_scenarios.py
   ```

4. NEVER trust jest's exit code as the verdict on a run, and never report a
   pass rate you read from stdout. The saved reports under the configured
   artifacts dir are the only source of truth, and they are written even when
   the run times out — see `references/run-behavior.md`.

5. At the end of a session that used this skill, run `protocols/self-refine.md`.

## Map

- `protocols/` the procedures named in step 1, plus `self-refine.md`.
- `references/` read on demand: `harness-map.md` (what each file owns and how a
  run is assembled), `scenario-contract.md` (what a scenario fixture means and
  the traps in it), `run-behavior.md` (config resolution, concurrency, retries,
  artifacts, what the numbers count).
- `scripts/check_scenarios.py` the mechanical check from step 3. Run it; do not
  reimplement it.
- `refinement-log.md` what past sessions changed here and why.
- `agents/openai.yaml` an interface manifest several `nexus-*` skills carry.
  Not a subagent prompt; nothing in this skill reads it.

## Siblings — name them, do not duplicate them

- `nexus-model-eval` — **grading models.** Which models to run, whether a slug
  resolves, how to read a leaderboard, and whether a failure indicts the model.
  That skill consumes the harness; this one changes it. If the question is "how
  good is model X", stop here and use it.
- `nexus-testing` — the gate that keeps this suite from running (and billing) in
  CI, and how to watch a run in flight.
- `nexus-agents` — the real `getTools`/`useTools` contract the fixtures imitate.
  When a fixture and production disagree, production wins, and that skill says
  what production does.
- `nexus-llm-adapters` — provider adapters. A run that fails inside streaming
  for one provider only is an adapter problem, not a harness problem.
- `nexus-tool-schemas` — the live tool catalog, for checking a fixture's tool
  slugs against the registry instead of guessing.
