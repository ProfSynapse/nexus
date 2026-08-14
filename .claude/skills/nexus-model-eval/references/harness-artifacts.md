# Failures the model did not cause

Context: read while attributing failures. Each entry is a symptom you will see
in a report, the mechanism behind it, and the proof that settles which side it
falls on. If a failure matches one of these and the proof holds, it is
`harness-artifact` or `fixture-bug` — not `model-failure`.

## Key idea
The harness grades a model against fixtures, not against Nexus. Three fixture
layers can disagree with each other: the system prompt's tool catalog, the mock
executor's tool definitions, and the individual scenario's scripted responses.
Every entry below is one of those disagreements.

## Symptom → cause → proof

### `Hallucinated tool call: "<name>" is not in the defined tool set`
**Cause.** The valid set is only the fixture tools. The eval system prompt is
built by the production prompt builder from a wider catalog, so the model is
told about agents the executor has never heard of. Any command that does not
resolve to a fixture tool is recorded under a fallback name and fails here.
**Proof.** Run `scripts/check_advertised_tools.py`. If the command appears in
its output, the model obeyed its own system prompt → `harness-artifact`. If it
does not, the model invented something nobody told it about → `model-failure`.

### The model calls `getTools` over and over and the scenario times out
**Cause.** A scenario that scripts a `getTools` mock response returns that same
payload for **every** selector — the scripted handler ignores its arguments. A
model that asks for an agent the scripted blob does not contain never sees it,
asks again, and at temperature 0 loops identically. (Without a scripted
response, the executor generates schemas and does filter by selector, so the
loop does not happen.)
**Proof.** Compare the `tool` selector in the model's repeated `getTools` calls
against the scenario's scripted `getTools` payload. Selector asks for something
the payload omits → `fixture-bug`; hand it to `nexus-eval-harness`. Selector
asks for something present and the model still re-asks → `model-failure`.

### `Expected tool "<agent>_<tool>" was not called` while the model's CLI string looks right
**Cause.** Inner domain calls are captured only when the executor unwraps the
CLI string itself. A scenario that scripts a `useTools` mock response is
answered *before* unwrapping, so no inner call is ever recorded and an
expectation naming a domain tool in that turn cannot be satisfied.
**Proof.** Does the failing turn's scenario script a `useTools` response and
expect a domain tool name in the same turn? Then no model can pass it →
`fixture-bug`. `nexus-eval-harness/scripts/check_scenarios.py` is the mechanical
version of this check.

### Round mismatches on a model that did the right work in the wrong shape
**Cause.** Without `allowReorder`, expected calls are consumed round by round. A
model that batches two commands into one `useTools` string, or inserts an extra
`getTools`, can shift the alignment and fail rounds it satisfied out of order.
**Proof.** Read the captured call list end to end. Every expected call present
but in a different arrangement, on a scenario without `allowReorder` → the
scenario is stricter than the contract; report it as `fixture-bug`. Genuinely
missing work → `model-failure`.

### A later exchange fails because the model "forgot" what a tool returned
**Cause.** Between exchanges, the runner replays history with a stub tool result
rather than the real payload, so content returned in an earlier exchange is not
visible in a later one. A scenario whose later turn depends on remembering
fetched content is asking for something the harness does not provide.
**Proof.** Does the failing expectation require a value that only appeared in an
earlier exchange's tool result? Then → `fixture-bug`. Does it merely require the
model to continue a plan it stated? Then → `model-failure`.

### `Stream error: …`
**Cause.** Transport, auth, rate limiting or a provider-side failure. Nothing to
do with tool use. Retryable ones are retried; a turn whose errors are all
non-retryable stream errors fails fast instead of burning the retry budget.
**Proof.** The error text carries the status or the transport failure. →
`provider-error`. Re-run that target rather than scoring it. A single provider
failing where others succeed is an adapter question — `nexus-llm-adapters`.

## Not artifacts — these are the model's own
- **Missing or empty `workspaceId`, `sessionId`, `memory`, `goal`.** Production
  enforces the same contract; a model that omits them fails in the app too.
- **Never calling `getTools` before `useTools`** on a scenario that requires
  discovery first.
- **Not chaining a required second step** — searching and never reading the hit.
- **Asking a clarifying question instead of acting** on a deliberately vague
  prompt. Some scenarios exist precisely to grade that.
- **Not recovering from a steering error.** The recovery scenarios reject the
  first calls no matter what the model sent; refusing to re-issue is a real
  failure of the protocol.
