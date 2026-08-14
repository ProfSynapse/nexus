# Protocol: debug a run

Context: run this when a finished or in-flight eval run does not make sense —
nothing ran, everything failed, one case hangs, Jest is red but the results look
fine, or two reports disagree.

## Mission
Attribute the anomaly to one of four layers — configuration, fixture, harness,
provider — and fix it at that layer.

## Steps

1. Establish what actually ran before theorising. The run's first line states
   the job count, the concurrency and the progress-log path; the log has one
   line per completed case with status and duration.

   ```bash
   ls -t test-artifacts/ | head
   tail -30 test-artifacts/eval-progress-*.log
   ```

   A job count of 0, or far fewer jobs than `scenarios × models`, is a filter
   problem — go to step 2. Otherwise skip to the symptom that matches.

2. **Nothing ran, or the suite passed suspiciously fast.** Work down this list:
   `RUN_EVAL=1` missing; no provider key resolvable (the loader warns per
   provider and the suite then skips and *passes*); the scenario glob matching
   nothing; `EVAL_SCENARIO_NAMES` naming a scenario that does not exist;
   `EVAL_TOOL_SET` filtering every scenario out; a scenario skipped by the
   loader for missing `name`/`turns`. Confirm the last one mechanically:

   ```bash
   python3 .claude/skills/nexus-eval-harness/scripts/check_scenarios.py
   ```

   Then check the repo-root `.env` for a stale override — without printing it.

3. **Every scenario fails the same way.** Read one failure's errors in the
   report, not the summary. Errors naming missing `workspaceId`, `sessionId`,
   `memory` or `goal` are the meta-arg contract, meaning the model is not
   filling the context block — a real finding. Errors inside streaming for one
   provider only belong to `nexus-llm-adapters`. Errors naming a tool that does
   not exist are a fixture problem — go to `add-a-scenario.md`.

4. **One case hangs or eats the whole budget.** Suspect the selector-blind
   discovery mock first: a scripted `getTools` payload that omits an agent the
   exchange needs makes a temperature-0 model retry discovery forever. The
   checker in step 2 fails on exactly that. Confirm from the transcript by
   counting `getTools` calls in the report's actual-calls list.

5. **Jest says the suite failed but the results look right.** Expected: a
   failing scenario is a failing expectation, and a matrix that brushes the test
   timeout aborts after results were already accumulated. NEVER report a run as
   broken on the strength of the exit code — open the saved report. A timed-out
   run still has the combined report; the per-model reports are the ones it
   loses.

6. **Two numbers disagree.** The markdown Metrics block counts every scenario;
   the JSON `byModel` rollup drops the ones flagged `excludeFromBoard`. Say
   which one you are quoting.

7. **You need to see inside the exchange.** Re-run the single case with
   `EVAL_TRACE_STREAM=1` and read the JSONL trace under the artifacts dir: it
   records chunks, reasoning, tool calls, tool events and the assertion result
   in order. For raw HTTP, the failure dumps from the request capture show what
   the provider actually received.

8. Stop condition: you can name the layer that produced the anomaly and have
   either fixed it or written it down as a finding.

## Guidelines

- Pattern: reproduce narrow. `EVAL_SCENARIO_NAMES` plus one model turns a
  half-hour matrix into a one-minute question.
- Pattern: when a model's calls look correct and the scenario still failed,
  believe the model. That asymmetry has been right often enough to be the
  default.
- Anti-pattern: raising a timeout to make a hang go away. The hang is a loop,
  and the loop has a cause in the fixture.
- Anti-pattern: diagnosing a slow run from the final summary. The progress log
  is the live view and it survives a timeout.

## Next

Fixture problems continue at `add-a-scenario.md`; harness problems at
`extend-the-harness.md`; configuration problems at `configure-a-run.md`. When
the anomaly is explained and nothing further is queued, end the session at
`self-refine.md`.
