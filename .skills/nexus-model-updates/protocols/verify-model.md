# Protocol: verify-model

Context: the registry entry is written and the project compiles. That proves the
literal is well-typed. It does not prove the id exists at the provider, that the
credentials reach it, that the price is right, or that the model can do anything
useful in Nexus. Each of those needs a different check, and they fail
independently.

## Mission
Evidence, at the right depth for the change, that the model works — from
structure, through a live call, to tool use.

## Steps

1. **Structural gate.** Non-zero is a stop.

   ```bash
   python3 .claude/skills/nexus-model-updates/scripts/check_model_registry.py \
     --repo-root . <provider>
   ```

   Use `--strict` if you changed a default. Read `references/consumers.md` for
   what each finding actually breaks at runtime.

2. **Unit lane.** The registry has unit tests that assert specific entries and
   defaults, and adapter tests that assert the model id a request body carries.
   Run the lanes that cover what you touched; `nexus-testing` owns lane choice.
   These are the tests that fail loudly when a default moves, so a failure here
   is usually correct and wants an updated expectation, not a relaxed assertion.

3. **Build.** `npm run build`. It regenerates embedded assets under `src/utils/`
   that are marked auto-generated; if they show up in your diff they are build
   output, not part of your change, and you MUST NOT hand-edit them.

4. **Live call — mandatory for any id that is new to this repo.** The reusable
   smoke lane calls the real endpoint through the real adapter. Read
   `references/smoke-harness.md` before the first run: it covers the env gate,
   which providers the lane can drive, where it takes credentials from, how it
   normalizes the id, and the two failure modes that look like a dead model but
   are not. The shape is:

   ```bash
   RUN_MODEL_SMOKE=1 MODEL_SMOKE_PROVIDER=<provider> MODEL_SMOKE_MODEL=<id> \
     npx jest tests/debug/provider-model-live-smoke.test.ts \
     --runInBand --no-coverage --verbose
   ```

   Read the test file's header for the authoritative invocation rather than
   trusting a copy — including this one. If the provider is not one the lane can
   construct an adapter for, say so in your report instead of reporting an
   untested id as verified.

5. **Tool use — required before a model becomes a default or a recommendation.**
   A passing smoke test means the endpoint returned text. It says nothing about
   whether the model can discover tools and call them correctly, which is the
   only thing Nexus actually needs from it. Hand that to `nexus-model-eval`; it
   owns the grading procedure and how to read the result. Do not restate its
   thresholds here — they move as the harness and the scenario set change.

6. **Report what you actually ran.** Name the providers and ids touched, whether
   any default moved, and for each id: gate result, unit lane result, live smoke
   result or the reason it could not run, and tool-use grade or the reason it was
   not required. An id that skipped step 4 MUST be reported as unverified.

## Guidelines
- Pattern: match depth to blast radius. A price correction on an existing id
  needs steps 1–3. A new id needs step 4. A new default needs step 5.
- Pattern: run the smoke lane for one provider at a time while iterating. Running
  every provider spends credentials and time on models you did not change.
- Anti-pattern: reporting "added and tested" when only the unit lane ran. The
  unit lane reads the same literal you just wrote.
- Anti-pattern: treating a smoke failure as a bad model id before ruling out the
  impostors in `references/smoke-harness.md`. Most first failures are one of
  them.
- Anti-pattern: pasting credentials, tokens or `.env` contents into a report.

## Next
`self-refine.md` at the end of the session. On a failure, return to
`add-model.md` or `change-default.md` and re-enter here.
