# Protocol: configure a run

Context: run this when setting up an eval run — choosing mode, targets,
scenarios and retry behaviour — whether the config is a throwaway env line or a
committed YAML file.

## Mission
Produce a run whose settings you can defend afterwards: the right mode, a matrix
that finishes, and numbers nobody has to caveat.

## Steps

1. Choose the mode, and know what it costs you.
   - **mock** — tool results are scripted. This grades tool *invocation*: did
     the model discover, then call, the right thing with the right arguments.
     It needs no vault.
   - **live** — real agents execute against a throwaway vault directory. It also
     proves execution, but only for the agents the headless stack registers, and
     every `obsidian` import still resolves to the repo's hand-written mock, so
     anything built on Obsidian's own helpers behaves like that mock rather than
     like the app. Read the mode table in `../references/harness-map.md` before
     choosing live.

2. Choose how targets are named.
   - Iterating: `EVAL_TARGETS='provider=model,provider=model'` (or
     `EVAL_PROVIDER` **with** `EVAL_MODELS` — either alone throws).
   - Repeatable or committed: a YAML file under `tests/eval/configs/`, selected
     with `EVAL_CONFIG`. Copy the closest existing file rather than writing one
     from scratch, and name it for the job and the date.

   Remember that a target env var **replaces** the config's whole providers
   block. Do not set both and expect a union.

3. Set retries deliberately. Behavioural failures are retried too, so a nonzero
   `maxRetries` hands the model extra attempts and inflates the pass rate. Use 0
   when the number is a measurement; leave retries on when you care about
   getting through a flaky provider, and discount any pass with a nonzero
   `retryCount` in the report.

4. Pin the tool contract when comparing results across releases. Set
   `schemaVersion: X.Y.Z` in YAML or `EVAL_SCHEMA_VERSION=X.Y.Z`; omit it to use
   the schema manifest's `latest`. The resolved version is written to each
   report.

5. Size the run before launching it. Concurrency is full fan-out unless a local
   provider is in the matrix (then serial) or `EVAL_CONCURRENCY` says otherwise,
   and the Jest test timeout has to cover the whole matrix — raise
   `EVAL_TEST_TIMEOUT_MS`, not `defaults.timeout`, when a large matrix runs out
   of budget. `../references/run-behavior.md` has the details.

6. Before launching, confirm the environment is not lying to you. Values resolve
   from `process.env` **or** the repo-root `.env`, so a leftover `EVAL_MODE` or
   `EVAL_TARGETS` there will redirect the run. Check that the variables you care
   about are unset or intentional — and NEVER print `.env` or a key.

7. Launch. There is no npm script; the entry point is the Jest file, and
   `RUN_EVAL=1` plus at least one resolvable provider key is mandatory or the
   suite skips and passes:

   ```bash
   mkdir -p test-artifacts
   RUN_EVAL=1 EVAL_CONFIG=tests/eval/configs/<file>.yaml \
     npx jest tests/eval/eval.test.ts --no-coverage --verbose
   ```

   Run anything larger than a single scenario in the background — a matrix takes
   minutes to hours. The run prints its job count, its concurrency and the path
   of its progress log on the first line; `tail -f` that log rather than waiting
   on buffered stdout.

8. Stop condition: the reports exist under the artifacts dir and the job count
   in the progress log header matches the matrix you intended.

## Guidelines

- Pattern: narrow before you widen. One scenario against one cheap model finds
  fixture and config mistakes for a few cents.
- Pattern: commit a config when a matrix is worth re-running; keep it in env
  vars when it is not.
- Anti-pattern: reading a pass rate off stdout. Read the saved report.
- Anti-pattern: adding a knob to a config file when an env override already
  exists. The override wins anyway, and the file then documents a lie.

## Next

If the run produced nothing, all-fails or numbers that disagree, continue at
`debug-a-run.md`. If it ran cleanly and the question was how good a model is,
hand off to the `nexus-model-eval` skill. Otherwise end the session at
`self-refine.md`.
