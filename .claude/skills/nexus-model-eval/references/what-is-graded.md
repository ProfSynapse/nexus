# What is graded

Context: read before trusting a pass rate. This is what the harness measures,
what it ignores, and the three things that move a number for reasons unrelated
to how well the model behaved. Run mechanics — config resolution, env knobs,
where artifacts are configured to land — belong to `nexus-eval-harness`.

## Key idea
Grading is binary per scenario and unforgiving: a scenario passes only if every
one of its turns passed, and a turn passes only if its assertions produced zero
errors. There is no partial credit. The model's prose is never graded — a text
assertion exists in `tests/eval/assertions.ts`, but nothing in the runner calls
it, so a model can write a perfect answer and still fail, and can write nothing
at all and still pass.

## A "turn" is an exchange, not a model round
The runner groups a scenario's YAML turns into exchanges: a turn with a
`userMessage` opens one, and the turns after it without a `userMessage` are
further tool-call rounds *inside the same streaming response*. That mirrors
production, where one user message drives as many tool rounds as the model needs
within a single call. So a report's `2/3 turns` counts exchanges. All of an
exchange's rounds are asserted against the calls captured during that one
response.

## The assertion layers
Every one of these must come back clean for a turn to pass:

1. **Round assertions.** Each round's expected calls must appear, in round
   order, consuming the captured calls as it goes. A scenario that sets
   `allowReorder` drops the ordering requirement: the expected calls only have
   to appear somewhere in the exchange.
2. **Context contract.** Every `getTools`/`useTools` call must carry non-empty
   string `workspaceId`, `sessionId`, `memory` and `goal`, and must not carry the
   deprecated `context`, `calls` or `request` keys. This is the same contract
   production enforces. Failing it is a real model failure and one of the most
   common.
3. **No hallucinated tools.** Every captured call name must be in the fixture
   tool set — the two meta tools plus the domain tools in
   `tests/eval/fixtures/tools.ts`. Names wrapped in double underscores are
   executor artifacts, not model output, and are exempt.
4. **Recovery**, on scenarios that enable context steering: after the harness
   rejects a `useTools` call with the production steering error, the model must
   re-issue a valid one within the scenario's allowance.

## What a call is actually compared on
- For `getTools`/`useTools`, the expected `tool` string is parsed into
  selector/command pairs and compared on **agent and tool only**. Flag names,
  flag order and values in the CLI string are not compared at this level, and
  flag case never matters — the executor kebab-normalizes `--startLine` and
  `--start-line` to the same parameter. "The model used the wrong flag style" is
  therefore almost never why a scenario failed.
- An expectation naming an **inner domain tool** does compare arguments, against
  the args the executor parsed out of the model's CLI string.
- String comparison is case-insensitive substring, not equality. A param error
  means the model's value did not even contain the expected text.

## Three things that move a number without the model changing
- **Retries.** A failing scenario is retried up to `maxRetries` — behavioral
  failures included, not just network ones. Only a turn whose errors are *all*
  non-retryable stream errors fails fast. So `Retries used > 0` means a scenario
  failed at least once and was given another attempt; a pass that needed one is
  an unstable pass at temperature 0, and should be reported as such.
- **Board exclusions.** A scenario can be flagged to run and report but not count
  toward a model's rate. The JSON report's per-model rollup honours that flag;
  the markdown report's metrics block counts every result. Two different pass
  rates from one run is expected, not a bug. `summarize_eval.py` follows the
  JSON rule and prints the excluded count separately.
- **A partial matrix.** Results accumulate as each job finishes, so a run that
  hit the overall test timeout still writes reports for the jobs that completed.
  A model with noticeably fewer scenarios than its peers was cut short; its rate
  is not comparable.

## Where the evidence is
Confirm with `ls test-artifacts/` rather than trusting a filename from memory.
A run leaves: a markdown and a JSON report per model, a combined pair for the
whole run, a progress log with one line per finished job, a captured
request/response dump for failures, and — only when stream tracing is enabled —
a JSONL trace per scenario. The JSON report is the one to grade from: the
markdown truncates tool-call arguments and model responses.
