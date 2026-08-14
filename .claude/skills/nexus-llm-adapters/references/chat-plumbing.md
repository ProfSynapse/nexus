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
