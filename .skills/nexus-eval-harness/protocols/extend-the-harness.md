# Protocol: extend the harness

Context: run this when the harness itself has to change — a new scenario field,
a different assertion, executor behaviour, loader or report output. Changing the
harness changes the meaning of every past number, so this protocol is about
keeping the grader honest.

## Mission
Land a harness change that is faithful to production, covered by a model-free
test, and explicit about which historical results it invalidates.

## Steps

1. Find the seam in `../references/harness-map.md` and confirm the change
   belongs there. A change that makes one scenario pass belongs in the scenario
   (`add-a-scenario.md`), not in the grader.

2. Decide whether the behaviour already exists in production. If it does, you
   MUST import it rather than reimplement it — the harness already reuses the
   real context-contract validator and the real system-prompt builder precisely
   so the grader cannot drift from the app. A hand-copied rule grades a
   yesterday that no longer exists.

3. Keep the two executors interchangeable. `EvalToolExecutor` (mock) and
   `LiveToolExecutor` (live) are both plugged in as the production
   `IToolExecutor` and both must keep capturing calls under the same names, or
   assertions silently mean different things in the two modes.

4. If you touched the scenario contract in `tests/eval/types.ts`, the checker
   follows automatically — it reads the field list and the tool-set union from
   that file. Re-run it over the existing fixtures to see what your change
   invalidates:

   ```bash
   python3 .claude/skills/nexus-eval-harness/scripts/check_scenarios.py
   ```

5. Cover the change where it costs nothing. The harness has model-free suites
   that run with no key and no network:

   ```bash
   npx jest tests/eval/EvalToolExecutorRecovery.test.ts tests/eval/headless --no-coverage
   ```

   Extend those rather than proving the change with a live matrix. Make the new
   test fail once before you make it pass.

6. Run the full unit lane, because harness files import production code and a
   change here can break a shared module:

   ```bash
   npm run test
   ```

7. Prove it end to end on one scenario against one cheap model
   (`configure-a-run.md`), and compare the result to the same scenario before
   the change.

8. Say what the change invalidates. If grading got stricter or looser, past
   reports are no longer comparable — write that down wherever the numbers were
   quoted, and note it in `../refinement-log.md`.

9. Stop condition: checker clean, model-free tests green, unit lane green, one
   real scenario re-run and explained.

## Guidelines

- Pattern: prefer widening what the grader accepts over teaching every fixture a
  new trick. Models differ legitimately; fixtures should not all have to encode
  each difference.
- Pattern: when in doubt about production behaviour, read the production file —
  `nexus-agents` owns the real two-tool contract.
- Anti-pattern: a one-off runner script beside the harness. It will disagree
  with the harness within a week and nobody will notice which one is right.
- Anti-pattern: fixing a grading complaint by loosening an assertion until
  everything passes. An assertion that cannot fail is not a grader.

## Next

If the change was driven by a confusing run, return to `debug-a-run.md` and
confirm the anomaly is gone. Otherwise end the session at `self-refine.md`.
