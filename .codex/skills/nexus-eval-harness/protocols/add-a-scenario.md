# Protocol: add or fix a scenario

Context: run this when a behaviour needs an eval scenario, or when an existing
scenario is grading models wrongly. This is the procedure that matters most in
this skill — a bad fixture is indistinguishable from a bad model in every report
the harness writes.

## Mission
Land a scenario whose pass means the model did the right thing and whose fail
means it did not, proven by one real run.

## Steps

1. State the behaviour in one sentence — "after a search hit, the model reads the
   file it found" — and check no existing scenario already grades it:

   ```bash
   grep -rn "^- name:" tests/eval/scenarios/
   ```

   If the goal is instead to find out how good a model is, stop: that is
   `nexus-model-eval`.

2. Read `../references/scenario-contract.md` before writing YAML. You MUST NOT
   author a scenario from the type definitions alone — the types say nothing
   about exchanges, last-write-wins registration, or the selector-blind
   discovery mock, and each of those silently inverts a result.

3. Copy the shape of the closest existing file in `tests/eval/scenarios/`, and
   read `tests/eval/types.ts` for the current field list. Structure the turns
   deliberately: a `userMessage` opens an exchange, every following turn without
   one is another tool round inside that same reply.

4. Decide the discovery mock. **Prefer scripting no `getTools` response at
   all** — the auto-generated catalog filters by the model's selector, the
   scripted one does not. If the scenario needs a scripted discovery payload,
   it MUST expose every agent that exchange could plausibly need, or the model
   will loop `getTools` until the timeout and be recorded as having failed.

5. Write the expectations at the altitude you actually care about. A `useTools`
   expectation compares the `agent tool` command prefix only; assert paths and
   flags on the unwrapped domain call. Set `allowReorder: true` whenever the
   order between calls is genuinely free.

6. Script the results the model needs to make its next decision. An unscripted
   tool returns a synthetic success, so a scenario can pass while proving
   nothing — script every result the next step depends on, and make it
   consistent with the file the earlier step claimed to find.

7. Run the checker from the repo root and fix everything it prints:

   ```bash
   python3 .claude/skills/nexus-eval-harness/scripts/check_scenarios.py
   ```

8. Run the scenario once for real against the cheapest capable model, narrowed
   to itself, and read the saved report rather than stdout:

   ```bash
   RUN_EVAL=1 EVAL_TARGETS='<provider>=<model>' \
     EVAL_SCENARIO_NAMES='<scenario-name>' \
     npx jest tests/eval/eval.test.ts --no-coverage --verbose
   ```

   Pick the provider and model from what the repo already targets
   (`ls tests/eval/configs/`) and what has a key set. See
   `configure-a-run.md` for the knobs and `debug-a-run.md` if it misbehaves.

9. Judge the result against the transcript, not the verdict. Open the failing
   turn's actual calls in the report: if the model produced the correct calls
   and still failed, the fixture is wrong — fix the fixture. If you cannot
   decide yet, set `excludeFromBoard: true` rather than deleting the scenario or
   leaving it to penalise every model.

10. Stop condition: the checker is clean, one real run has been read, and the
    scenario's pass/fail matches your own reading of the model's calls.

## Guidelines

- Pattern: make the scenario fail on purpose once — point an expectation at the
  wrong tool and confirm it goes red. A scenario that has never failed has not
  been shown to grade anything.
- Pattern: one behaviour per scenario. Multi-behaviour scenarios produce a
  failure you cannot attribute.
- Anti-pattern: tightening a scenario until only one phrasing passes. Models
  legitimately differ on order and on flag style; grade the outcome.
- Anti-pattern: deleting a scenario that fails everywhere. That is usually the
  fixture, and deleting it destroys the evidence — quarantine it instead.

## Next

If the run behaved oddly rather than the model, continue at `debug-a-run.md`.
If fixing this scenario required changing the harness itself, continue at
`extend-the-harness.md`. Otherwise end the session at `self-refine.md`.
