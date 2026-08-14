---
name: nexus-model-eval
description: Grade how well a model drives the Nexus two-tool protocol (getTools/useTools) and decide whether a low score is the model's fault or the harness's. Use when asked to grade, benchmark, rank or compare models on Nexus tool use, when picking a default model, or when an eval report needs interpreting.
---

# Nexus model eval

Context: the harness in `tests/eval/` shows a model the same two tools the app
does — `getTools` for discovery, `useTools` for execution — and grades the calls
it makes, not the prose it writes. This skill owns the verdict: which models to
run, and what a FAIL actually means. Running, configuring and extending the
harness itself belongs to `nexus-eval-harness`. This file routes; detail loads
when you take the path.

## Workflow
1. Get current truth before running anything. A model cannot be graded on a
   fixture no model can satisfy, and the fixture set moves:
   ```bash
   ls tests/eval/scenarios/ tests/eval/configs/
   python3 .claude/skills/nexus-eval-harness/scripts/check_scenarios.py
   python3 .claude/skills/nexus-model-eval/scripts/check_advertised_tools.py
   ```
   A non-zero exit from the scenario checker means some scenario can never pass;
   resolve that first, and the fix belongs to `nexus-eval-harness`, not to this
   run. The advertised-tools gap is not a defect — it is the list of correct
   model behaviors this harness punishes, and you will need it in step 3.
2. Run the grade: `protocols/grade-models.md`. Read it before you start; a
   summarized procedure is one you will improvise, and every scenario in the
   matrix costs live, billed API calls.
3. You MUST attribute every failure before you report a number:
   `protocols/attribute-failures.md`. The harness fails models for things the
   model did not do, so a raw pass rate with unread failures is not a grade.
   `scripts/summarize_eval.py --labels` refuses to sign off while any failure is
   unlabelled.
4. Report both numbers — raw pass rate and the attributed rate that charges only
   `model-failure` verdicts — plus what the excluded failures actually were. One
   number alone is either unfair to the model or unfair to the reader.
5. At the end of a session that used this skill, run `protocols/self-refine.md`.

## Map
- `protocols/` the procedures: `grade-models.md` (target list → run → artifacts),
  `attribute-failures.md` (FAIL → verdict → defensible grade), `self-refine.md`.
- `references/` read on demand: `what-is-graded.md` (what makes a scenario pass,
  what a "turn" counts, how retries and exclusions move the number),
  `harness-artifacts.md` (symptom → cause → proof for failures the model did not
  cause — read this before blaming any model).
- `scripts/` run them, do not reimplement:
  - `scripts/check_advertised_tools.py` — the commands the eval system prompt
    tells the model to use that the executor cannot run, so obeying the prompt
    scores as a hallucination.
  - `scripts/preflight_models.py` — do these slugs exist, before the run spends
    money proving they do not.
  - `scripts/summarize_eval.py` — report JSON → per-model rollup, bucketed
    failures, and an attribution that is checked rather than asserted.
- `refinement-log.md` what past sessions changed here and why.

## Siblings
The boundary with `nexus-eval-harness`: **it owns the instrument, this skill owns
the verdict.** Anything that changes the harness or its inputs — env knobs,
target syntax, live mode and the headless vault, config YAML, scenario authoring,
harness code — is that skill's. Anything that changes what you conclude about a
model is this one's. When a run reveals a fixture defect, hand it over rather
than fixing it here.

Also: `nexus-model-updates` owns provider model definitions and whether a model
ID works at all (grade nothing until it does); `nexus-testing` owns Jest lanes
and what a mock can prove; `nexus-agents` owns the two-tool contract the harness
is imitating; `nexus-llm-adapters` owns the adapter a stream error comes from.
