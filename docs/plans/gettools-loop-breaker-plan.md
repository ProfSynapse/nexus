# Plan: getTools Loop-Breaker + Tool-Result "What's Next" Decoration

**Status:** Proposed (scoped, not yet implemented)
**Date:** 2026-06-19
**Origin:** Eval failure-pattern analysis — two recurring model failures share one root cause.

## Problem

Two distinct model failures observed across the eval sweep turn out to be the same disease:

1. **getTools loop.** A model forms a plan (e.g. "search for 2024 notes, then move them"), calls `getTools` for a tool, gets back something it reads as "not what I asked for / incomplete," and **re-issues getTools forever**. Observed live: gemma-4-31b made 24 calls / 1307s on `vague-organize-request`, its own `memory` annotations cycling through *"getTools returned storage tools instead of search"*, *"only a subset."* At temperature 0 this is a deterministic fixed point — the same context yields the same getTools call every round until the global iteration cap or timeout.

2. **search→read satisfice.** A model runs `search content`, gets `{path, score}` (a *location*, no contents), and **answers anyway — fabricating the file body from the path**. `search-then-read-chain` failed 0/5 across all cloud models AND gemma local; a soft system-prompt nudge ("after search you're encouraged to read") did **not** move it.

**Common root cause:** the model cannot tell *when it has what it needs*. It either **satisfices** (search result → fabricated answer) or **thrashes** (getTools → infinite loop). Both are "uncertainty about task state," and both are best fixed where the model can't ignore it: **in the tool result itself.**

### What already exists (and why it's insufficient)
- `ToolContinuationService.TOOL_ITERATION_LIMIT = 15` (src/services/llm/core/ToolContinuationService.ts:42) is a *global* backstop that yields `TOOL_LIMIT_REACHED` after 15 total iterations. It fires too late (15 wasted rounds), is not specific to discovery loops, and tells the model to *ask the user* rather than *correct course*.
- The system-prompt 3-bucket reframe (exploration→inspection→exploitation) helped discovery/protocol patterns but did NOT fix either failure above — prompt-level guidance loses to in-the-moment satisficing.

## Approach — two surgical, low-risk interventions

Both are **steers, never blocks**: they add guidance to a tool result; they never reject a call or change what executes. Legitimate multi-step work is unaffected.

### Intervention A — getTools loop-breaker (orchestrator)

In `ToolContinuationService`, track getTools calls *within one user exchange*:
- Keep a small ring of recent `getTools` selectors (the `tool` arg string, normalized).
- **Trigger** when either: (a) ≥ N consecutive getTools calls with no intervening `useTools` (proposed N=3), OR (b) the *same* normalized selector requested ≥ 2 times.
- **On trigger**, append a steering note to that getTools result (not a new round, not an error):
  > `You have already discovered these tools this turn: [<accumulated tool list>]. getTools returns SCHEMAS, not data or results — it does not execute anything. To act, call useTools with a command, e.g. {"tool": "storage move --path X --destination Y"}. If a tool you want is not listed, it is not available for this task — adjust your plan with the tools you have.`
- Reset the tracker on each new user message (per-exchange, not per-session).

This converts a silent infinite loop into a single, actionable correction the model sees on its *next* token — and at temp 0 the changed context breaks the fixed point.

### Intervention B — tool-result "what's next" decoration (toolManager)

Decorate the *results* of the discovery/exploration tools so the model knows the result is intermediate:
- **getTools result** (src/agents/toolManager/tools/getTools.ts): prefix/annotate with `Discovered N tools. These are schemas — call useTools to run one.`
- **searchManager.content / searchManager.directory / storageManager.list results**: annotate with `These are locations/matches, not file contents. To read or act on a result, call useTools again (e.g. content read --path <path>).`

This is production-realistic (a real search API returning hits *should* signal they're hits, not contents) and doubles as the recovery steer for the satisfice pattern — addressing failure #2 that the system prompt couldn't.

## Files
- `src/services/llm/core/ToolContinuationService.ts` — getTools tracker + steer injection (Intervention A). Per-exchange state reset where a new user message starts.
- `src/agents/toolManager/tools/getTools.ts` — getTools result decoration (Intervention B).
- `src/agents/searchManager/tools/*.ts` (content, directory) + `src/agents/storageManager/tools/list.ts` — result decoration (Intervention B). Keep the machine-readable payload intact; add a sibling `hint`/`guidance` field or a leading note line — do NOT mutate `data` shape (downstream parsers depend on it).
- Tests: unit coverage for the tracker (consecutive-getTools trigger, same-selector trigger, reset-on-new-exchange, no false-positive on legitimate getTools→useTools→getTools).

## Eval harness support (to measure the fix)
- Add a deterministic knob mirroring `forceContextSteering`: e.g. **`forceGetToolsLoop`** or simply rely on the now-fixed `vague-organize` plus a new scenario where the model's likely plan needs a tool the scenario *intentionally* omits — assert the model receives the steer and converges within `maxRecoveryRounds` rather than looping.
- Add a `search-then-read` recovery assertion: with Intervention B's decoration present in the mock search result, assert the model proceeds to `content read` instead of answering from the snippet.
- The JSON report's per-result `turns[].toolCalls` already makes "count consecutive getTools" trivial to assert offline.

## Risks / guardrails
- **False positives on legitimate discovery.** A model may legitimately call getTools twice for different agents before acting. Mitigate: trigger on *consecutive* getTools (no useTools between) or *repeated identical selector*, not on total getTools count. N=3 leaves room for normal multi-agent discovery.
- **Don't break the payload contract.** Result decoration must be additive (sibling field or note line); the no-ajv rule means downstream code reads `data`/`results` positionally — mutating shape would silently break callers.
- **Per-exchange reset.** The tracker must reset on each new user message, or a long conversation would accumulate false triggers.
- **Steer, never block.** Neither intervention rejects a call; both only add guidance. Worst case of a bad heuristic is a slightly noisy result, not a failed operation.
- **Keep the global `TOOL_ITERATION_LIMIT`** as the final backstop; the loop-breaker is an earlier, gentler, course-correcting layer.

## Sequencing
1. Intervention A (loop-breaker) — highest value, contained to one file; lands the behavior change.
2. Intervention B (decoration) — addresses the satisfice pattern the system prompt couldn't; touches several tool files but each change is tiny + additive.
3. Eval scenarios + harness knob to lock in regression coverage.

Each is independently shippable and independently testable.
