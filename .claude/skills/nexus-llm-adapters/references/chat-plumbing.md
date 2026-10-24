# Chat branch and subagent plumbing

Context: read when a branch or subagent behaves unexpectedly, or before
"correcting" a type conversion between storage and the view. Two things here look
like bugs and are not.

## Key idea
A branch **is** a conversation carrying parent metadata — a parent conversation
id, a parent message id, and a branch type. There is no separate branch entity.
That is why branch questions are answered by reading conversation metadata.

## Two branch-type vocabularies, deliberately different
The **stored** branch type and the **view-layer** union are not the same set, and
the conversion between them collapses everything that is not a subagent into the
view's generic value.

Consequences:
- A value you stored may not be the value the UI reports, and that is correct.
- Widening the view union to match storage, or vice versa, changes rendering
  decisions elsewhere.

Read both declarations before treating a mismatch as a defect:

```bash
rg -n "branchType" src/ --type ts
```

The storage-side declarations, the view-side union, and the helpers that convert
between them will all be in that output. They are declared separately on purpose.

## Subagent tool calls are already executed
The `chunk.toolCalls` a subagent executor receives are **already executed and
carry their results** — the tool ping-pong ran inside the LLM service, upstream of
the executor, and the array accumulates across ping-pong iterations rather than
representing one new batch.

So consume them for display and status only. Re-executing them runs every side
effect a second time: a note written twice, a file archived twice, a message sent
twice. If a subagent path appears to need execution, the ping-pong contract has
been misread.

The same array is emitted to the tool-event layer so subagent tool bubbles render
the way parent chat's do. That emission is display, not dispatch.

## Text-only providers in subagents
A subagent asked to use tools with a text-only provider selected cannot do so;
the chat layer consults the same text-only-provider seam described in
`cli-providers.md`. Failing gracefully there is expected behaviour, not a wiring
gap.

## Related
- Reasoning survives the branch layer via the active-alternative resolver:
  `reasoning-rendering.md`.
- Conversation persistence, migrations, and storage shape belong to the
  `nexus-storage` skill.

## Context handoffs

A model or budget change must prepare with the previous model, then commit the
new model, effective window and compaction frontier together. Test through the
real budget and prompt-building code; a mocked successful compaction can hide
an oversized prompt. If all current messages are summarized, persist an
exclusive boundary tied to the last summarized message so future messages still
reach the model. Cover retries whose target predates that boundary, too.

When testing a handoff, compact the result again. Frontier merges must carry
forward the newest known boundary and its inclusive/exclusive mode. Ordinary
compaction must summarize only the active suffix, and a no-op must leave the
previous boundary intact. Separately, retry regeneration must replace provider
replay metadata: merging a previous Anthropic response into a new answer can
make the next prompt differ from the answer visible in chat.


## Saved-state compaction

Ordinary compaction drafts `createState` arguments from the active conversation
and prior checkpoint, then the host executes the real state tool once. The JSON
drafting call has no native tools: a local model need not implement function
calling to preserve context. The output target is a percentage of the effective
selected/runtime window, capped by known output allowance and actual prompt room.

Keep the complete saved state in conversation metadata and in the next prompt.
Do not pass it through the legacy frontier's short meta-summary merge. Resolve
previous tool references against the live catalog, newest first; optional schemas
must yield space to the state and retained turns. Test repeated compaction,
reopening, and JSONL replay rather than only the first boundary change.

A restored model selection must retain its output allowance on both discovery
and static/custom fallback paths. The static model service calls this field
`maxTokens`; runtime `ModelInfo` calls it `maxOutputTokens`. Read both types before
mapping them into `ModelOption`.


The compaction prompt also carries a bounded chronological snapshot of original
session goal/memory entries, including original native-chat call arguments when
no separate MCP trace exists. Keep this distinct from the generated checkpoint:
it shows the recent sequence of working context and intent. Use nested batch
command outcomes when present; successful useTools dispatch alone does not mean
a requested command succeeded. Allocate state and recent turns first, then this
timeline, then optional schemas. Preserve the snapshot through handoffs and
reloads, and resize it for the effective selected window.


A compacted prompt should explicitly explain how to recover missing details and
preload the current conversation-search tool even when it was never used in the
original exchange. Reserve state and recent turns first, then prioritize the
recovery schema before optional trace/schema extras. If the full signature is
too large, derive a labeled recovery subset from the live catalog and retain its
original argument definitions. Report unavailable or empty search honestly;
loading a tool schema does not establish that its conversation index has hits.
