# Protocol: attribute-failures

Context: runs after `grade-models.md` has produced report artifacts. A raw pass
rate is not a grade, because the harness fails models for things the model did
not do. This is where a number becomes defensible.

## Mission
Give every failure a verdict backed by the calls the model actually made, and
report a grade that charges the model only for its own mistakes.

## Steps

1. Work from the JSON report, not the markdown one. The markdown truncates each
   tool-call argument blob and each model response, which is exactly the evidence
   an attribution turns on. Both are written per model and for the run as a whole.

2. Bucket the failures:
   ```bash
   python3 .claude/skills/nexus-model-eval/scripts/summarize_eval.py test-artifacts/
   ```
   The bucket says where the assertion broke, in the harness's own error
   vocabulary. It does not say whose fault it was — that is step 4.

3. Load the two things that decide most attributions:
   - `references/harness-artifacts.md`, keyed by symptom, for failures no model
     could have avoided.
   - the output of `scripts/check_advertised_tools.py`, which lists the commands
     the system prompt tells the model to use and the executor cannot run.

4. For each failure, read the model's actual calls in the JSON — the tool names,
   the `tool` string, the context fields — and assign exactly one verdict:
   - `model-failure` — the model got the protocol wrong. Charged against it.
   - `harness-artifact` — the fixture made this unwinnable. Not charged.
   - `fixture-bug` — the scenario itself is wrong. Not charged; report it to
     `nexus-eval-harness` rather than leaving it for the next grader to redo.
   - `provider-error` — transport, auth or rate limit; nothing about tool use.
     Not charged; re-run that target if you want the scenario scored at all.
   You MUST NOT resolve a doubtful case by charging the model. When the evidence
   does not decide it, keep `unverified`, open the request capture or the
   `EVAL_TRACE_STREAM` trace for that scenario, and read what was actually sent.

5. Write the verdicts to a labels file and have them checked:
   ```bash
   python3 .claude/skills/nexus-model-eval/scripts/summarize_eval.py test-artifacts/ \
     --labels test-artifacts/labels.json
   ```
   Exit 1 lists what is unlabelled, mislabelled, or still `unverified`. Loop back
   to step 4 until it exits 0. The attributed rate it then prints is the number
   you report.

6. Report: raw rate, attributed rate, and one line per excluded failure saying
   what it was. Name the surface and the scenario set. If a model's two numbers
   are far apart, that gap is the most useful thing in the report — it means the
   harness, not the model, produced most of the difference.

## Guidelines
- Pattern: quote the model's own call when charging it. "Called `useTools` with
  an empty `memory`" survives review; "failed the context contract" does not.
- Pattern: a scenario that passes only after a retry is a weak pass, not a
  strong one — say so, because the harness re-runs failures and reports the
  eventual result.
- Anti-pattern: attributing from the bucket alone. Buckets group error text;
  the same text has both innocent and guilty causes.
- Anti-pattern: quietly dropping a scenario that embarrasses a favoured model.
  Exclusions are reported, with reasons, or they are not exclusions.

## Next
This is the terminal protocol for a grading job. Hand the two numbers and the
exclusion list to the user, then run `self-refine.md` before the session ends.
