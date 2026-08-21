# Scenario contract

Context: read this before writing or editing a `*.eval.yaml` fixture. The field
list itself lives in `tests/eval/types.ts` (`EvalScenario`, `EvalTurn`,
`ExpectedToolCall`, `MockToolResponse`) and is not copied here — read it there,
and let `scripts/check_scenarios.py` enforce it. What follows is what those
types do not tell you: the semantics a fixture author gets wrong.

## Key idea

A scenario is a script for the *tool environment*, not for the model. You
control what the model is asked, what tools appear to exist, what those tools
appear to return, and what calls count as correct. Every one of those four is a
way to fail a model that behaved perfectly.

## Turns are rounds; a userMessage starts an exchange

`EvalRunner` groups turns into **exchanges**. A turn with a `userMessage` opens
a new exchange; every following turn without one is another *tool round inside
the same streaming response*. One exchange is exactly one
`generateResponseStream` call, and the orchestrator's internal ping-pong drives
the rounds — you are not sending a second message, you are describing the second
round of the same reply.

Consequences:
- All of an exchange's `mockResponses` are registered **before** the stream
  starts, so the model can reach any of them in any round.
- Non-sequential registration is name-keyed and last-write-wins. If two rounds
  of one exchange both script `getTools`, the **second one answers the first
  round too**. Set `sequentialMockResponses: true` to consume responses FIFO
  instead — that is how you script tool→error then tool→success.
- Grading is per exchange, and one `TurnResult` is emitted per exchange, not per
  YAML turn. A four-turn single-exchange scenario reports one turn.

## The forever-loop trap: a scripted `getTools` is selector-blind

This is the single most expensive fixture mistake.

`registerStaticResponse` builds a handler that **discards its arguments**. So a
scenario that scripts a `getTools` mock returns that same payload for every
`getTools` call in the exchange, whatever selector the model asked for. A model
that asks for `search`, receives a catalog containing only `content`, and is
run at temperature 0 will conclude discovery is broken and ask again — forever,
until the per-case timeout burns the budget and the scenario is recorded as a
model failure.

Only the *scripted* path is blind. With no scripted `getTools`, the executor
auto-generates the catalog from `fixtures/tools.ts` and **does** filter by the
requested selector — do not misdiagnose the auto-generated path this way.

So: prefer no scripted `getTools` at all, and when you must script one, expose
every agent that exchange could plausibly need.
`scripts/check_scenarios.py` fails on exactly this case.

## An absent mock does not fail — it invents a success

A domain tool with no registered handler returns
`{ success: true, result: { message: "Mock response for <name>" } }`. Nothing
warns. A scenario whose assertions pass because the model never needed the
result it was supposed to get looks identical to one that works.

## What the assertions actually compare

- **Meta-arg contract.** Every captured `getTools`/`useTools` call must carry
  non-empty `workspaceId`, `sessionId`, `memory` and `goal`, and must not carry
  the retired `context`, `calls` or `request` keys. This fires on every expected
  meta call whether or not you wrote `params`.
- **`params.tool` on a meta call compares agent and tool only.** For `getTools`
  the expected selectors must appear among the actual selectors; for `useTools`
  the expected `agent tool` command prefixes must appear among the actual
  commands. Flags and values in that string are **not** compared, so
  `tool: "content read"` is the whole assertion — it does not check the path.
- **Domain-tool params are substring-matched.** Expected string values match
  case-insensitively as substrings of the actual value, and nested objects match
  partially. Assert the path on the unwrapped domain call when you care about
  arguments.
- **Rounds are consumed in order** unless `allowReorder: true`, which only
  requires that every expected call appears somewhere in the exchange. Reach for
  it whenever the order is genuinely free (search-then-read versus
  read-then-search); an over-strict round assertion is a fixture bug that reads
  as a model bug.
- **`optional: true`** expectations are skipped entirely, not scored.
- **Hallucination check.** Every captured name must be a tool in
  `fixtures/tools.ts` (meta or domain). Executor artifacts wrapped in
  `__double_underscores__` are exempt by design — they record a recoverable
  runtime error surfaced back to the model, exactly as production does.

## Recovery scenarios

Three fields grade whether a model recovers from a steering error, using the
**production** validator (`ToolCliNormalizer`), not a copy:

- `enforceContextContract: true` rejects a `useTools` call whose context block
  fails that validator. It only fires if the model errs first.
- `forceContextSteering: N` rejects the first N `useTools` calls regardless of
  input, so recovery is exercised deterministically.
- `maxRecoveryRounds` caps how many steering errors count as a recovery.

`EVAL_ENFORCE_CONTEXT=1` turns the first one on globally, which is a cheap way
to ask "does this model self-correct" across every existing scenario.

## Thinking scenarios grade the Nexus stream, not hidden provider tokens

The optional `thinking` scenario block sends the same enable/effort controls as
the app and grades only what `StreamingOrchestrator` exposes: visible reasoning
text, its order relative to the first tool call, and whether normal answer text
arrives after the continuation. It cannot prove that a provider reasoned
internally when that provider deliberately withholds all summaries.

Use a tool round when testing thinking with Nexus. A text-only prompt proves
reasoning display, but not whether signed or opaque provider state survives the
tool-result continuation. Keep capability probes excluded from leaderboard
aggregation when some targeted models legitimately do not expose reasoning.

## Quarantine, do not delete

`excludeFromBoard: true` runs and reports a scenario but keeps it out of the
per-model leaderboard in the JSON report. That is the right move for a fixture
you suspect is wrong: the evidence keeps accumulating while it stops penalising
models. Note the markdown report's Metrics block still counts it — see
`run-behavior.md`.

## Tool slugs come from production, not from memory

A scenario's agent and tool names must match the real slugs (the first argument
to each tool's `BaseTool` constructor), reduced the way the harness reduces
them: the agent alias drops a trailing `Manager`/`Agent` and kebab-cases the
rest. Getting this wrong produces "expected tool not called" against a model
that called the right tool. `scripts/check_scenarios.py` resolves every
selector and expected name against `fixtures/tools.ts`; `nexus-tool-schemas`
exports the live catalog when you need to check the fixtures against the real
registry.
