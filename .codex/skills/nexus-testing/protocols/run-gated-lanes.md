# Protocol: run (and add) the gated lanes

Context: two lanes cost real money, real time or a real vault, so they make
themselves inert unless explicitly enabled — the live smoke lanes under
`tests/debug/` and the LLM eval harness under `tests/eval/`. That inertness is a
property each *file* asserts about itself. Jest collects every lane under
`npm run test`, so a live lane written without a gate runs in CI.

## Steps

### Running a live smoke lane

1. **Read the file's header before running it.** Each lane documents its own
   gate, and they differ. Never assume a gate name.

   ```bash
   ls tests/debug/*.test.ts
   grep -oE 'process\.env\.[A-Z_]+' tests/debug/<file>.test.ts | sort -u
   ```

2. **Run it explicitly, in band, without coverage.** Live lanes are not safe to
   parallelise.

   ```bash
   <GATE>=1 npx jest tests/debug/<file>.test.ts --runInBand --no-coverage
   ```

   Several lanes need more than the gate — a provider key, a fixture path, or a
   vault name. The header says which; the grep in step 1 lists the variables.

### Adding a live smoke lane

3. Copy the structure of `tests/debug/search-ranking-live-smoke.test.ts`. Five
   conventions, each paid for by a real incident:
   1. **Gate it.** Select `describe` or `describe.skip` from an env var, so the
      file is inert by default and never a CI dependency.
   2. **`--runInBand`** in the documented invocation.
   3. **A header comment** stating what the mocks cannot cover — the next person
      needs to know why the lane is worth its cost.
   4. **Confine writes** to a dedicated scratch folder and clean up in
      `afterAll` with `storage archive`, not delete. The AI surface has no
      delete by design; the cleanup must respect that.
   5. **Touch nothing else in the vault.**

4. Prove the gate holds:

   ```bash
   python3 .claude/skills/nexus-testing/scripts/check_live_lane_gates.py
   npm run test   # the new lane must SKIP, not run
   ```

### Running the eval harness

5. **Enable it.** `RUN_EVAL=1` plus at least one provider key, or the suite
   skips. Discover the current knobs rather than trusting any list:

   ```bash
   grep -rhoE 'process\.env\.[A-Z_]+' tests/eval/ | sort -u
   RUN_EVAL=1 npx jest tests/eval/eval.test.ts --no-coverage --verbose
   ```

6. **Understand the two knobs that behave unlike their names.**

   - **Concurrency is per-matrix, not a flat serial.** `resolveConcurrency` in
     `tests/eval/eval.test.ts` honours `EVAL_CONCURRENCY` first; otherwise it
     returns `1` only when a local provider (`ollama`, `lmstudio`) is in the
     matrix, and `Infinity` — full fan-out — for everything else. Local
     single-slot servers 500-storm under fan-out, which is the entire reason for
     that special case. So do NOT "fix" a slow cloud run by forcing serial, and
     do not expect a local run to behave like a cloud one.
   - **The per-test timeout covers the whole matrix**, scaled by the number of
     serial lanes. Override with `EVAL_TEST_TIMEOUT_MS` rather than shrinking
     the matrix to fit.

7. **Watch it while it runs.** Results are pushed into the accumulator as each
   scenario finishes and `afterAll` saves whatever is there, so a mid-run
   timeout still produces reports. Per-case progress streams to a log under the
   configured artifacts dir — the run prints the path on start. `tail -f` that
   instead of waiting for the summary; Jest buffers stdout in non-TTY runs, so
   the console output will not arrive live.

8. For anything beyond running it — adding scenarios, changing configs, reading
   the reports, grading a model — stop here and use `nexus-eval-harness` or
   `nexus-model-eval`. Do not re-derive their content in this lane.

## Guidelines

- Pattern: a gated lane that has never failed has not been shown to work. Break
  the thing it protects once and watch it go red.
- Anti-pattern: a live lane whose gate defaults to on "just for now". That is
  how a CI job acquires a provider bill.
- Anti-pattern: diagnosing a slow eval run by reading the summary. The progress
  log is the live view and it survives a timeout.

## Next

If the lane you just ran only reproduces inside the running app rather than
through the CLI, continue at `live-loop.md`. Otherwise end the session at
`self-refine.md`.
