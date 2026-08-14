# Protocol: grade-models

Context: runs the eval matrix for a named set of models and lands the artifacts
a grade is computed from. Every scenario in the matrix costs live, billed API
calls — one per exchange, per model, plus a retry when it fails — so this
protocol front-loads the checks that make a run worth paying for.

## Mission
Produce complete, comparable report artifacts for every model the user named —
or stop before spending anything, with the reason.

## Steps

1. Fix the target list in `provider=model` form, exactly as the user gave it.
   Do not substitute a model you think is equivalent, and do not silently drop
   one that looks wrong — check it:
   ```bash
   python3 .claude/skills/nexus-model-eval/scripts/preflight_models.py \
     openrouter=<vendor>/<model> openrouter=<vendor>/<other>
   ```
   Exit 1 means a slug does not exist: fix it with the user before running. Exit
   3 means the catalog was unreachable or the provider has no keyless catalog —
   say so, and let the user decide whether to spend the run unverified.

2. Choose the surface, and say which one you chose in the report. Mock mode is
   the default and the right one for grading protocol adherence: tool results are
   scripted, so every model is asked the same question and gets the same answers
   back, which is what makes two models comparable. Live mode executes real
   agents against a filesystem test vault and grades something else — a
   different question, owned by `nexus-eval-harness`. You MUST NOT put mock and
   live results in the same leaderboard.

3. Confirm the run will not silently do nothing. The suite needs `RUN_EVAL=1`
   **and** at least one enabled provider whose key resolves, or it passes with a
   skip message and no artifacts. The harness reads the key itself, from the
   process env or the repo-root `.env`; you do not need to open that file, and
   you MUST NOT print a key or paste one into a command line.

4. Run it in the background — a matrix takes minutes to hours — and watch the
   progress log rather than stdout, which jest buffers until the end:
   ```bash
   mkdir -p test-artifacts
   RUN_EVAL=1 EVAL_TARGETS='openrouter=<vendor>/<model>' \
     npx jest tests/eval/eval.test.ts --runInBand --no-coverage
   # in another shell:
   tail -f test-artifacts/eval-progress-*.log
   ```
   One line per finished job, with PASS/FAIL and duration. To narrow a run, or
   to use a config file instead of `EVAL_TARGETS`, see `nexus-eval-harness` —
   it owns the knobs.

5. Grade local models in their own run. If any local provider (Ollama, LM Studio)
   is in the matrix, the harness drops the **whole** matrix to one job at a time,
   because a single-slot local server queues parallel requests until they time
   out. A cloud model graded alongside a local one therefore runs serially for no
   benefit. `EVAL_CONCURRENCY=N` overrides in either direction.

6. Wait for the artifacts, not for jest. Jest's exit code is not the grade: the
   matrix test asserts only that at least one result came back, so a run where
   every scenario failed still exits green, and a run that timed out mid-matrix
   still writes reports for the jobs that finished. Read
   `references/what-is-graded.md` before trusting any number.

7. Collect and stop:
   ```bash
   python3 .claude/skills/nexus-model-eval/scripts/summarize_eval.py test-artifacts/
   ```
   Done when every requested model appears in the rollup with a plausible
   scenario count. A model with far fewer scenarios than its peers was cut short
   — re-run that target before comparing it to anything.

## Guidelines
- Pattern: state the surface, the scenario set and the date next to any number
  you report. A pass rate without them cannot be reproduced or compared.
- Anti-pattern: re-running until the number looks better. The harness already
  retries a failing scenario; a second manual run is a second sample, and if you
  keep it you MUST report both.
- Anti-pattern: editing a scenario so a model passes it. That is grading to the
  test. If a scenario is wrong, hand it to `nexus-eval-harness`.

## Next
`attribute-failures.md`. A run that produced artifacts is not a grade yet —
nothing has decided whether the failures belong to the model.
