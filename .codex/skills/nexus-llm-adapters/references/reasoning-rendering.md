# Reasoning rendering

Context: read when a model's thinking text is not appearing, or before adding
reasoning support to an adapter. Explains the one path that works and the one that
looks like it works.

## Key idea
Reasoning has a dedicated channel that runs parallel to content, all the way to
the bubble. Adapters put text on it; nothing else has to be built.

## The chain
`chunk.reasoning` (+ `chunk.reasoningComplete`) emitted by the adapter's stream
→ the chat stream handler accumulates it and calls
`onReasoningUpdate(messageId, accumulatedText, isComplete)`
→ `ChatView` forwards to `MessageDisplay.updateMessageReasoning`
→ `MessageBubble.updateReasoning` writes into a collapsible "Thinking" block,
open while the model is still thinking and closed once complete.

Two properties worth knowing:

- The handler pushes the **accumulated** text each time, not the delta. An adapter
  that accumulates before emitting will render duplicated reasoning.
- The bubble re-renders from the message's own `reasoning` field (via the state
  resolver, which respects the active branch alternative). Reasoning that never
  reaches that field survives streaming and disappears on the next full paint.

## The trap: do not route reasoning through a tool call
There was a previous mechanism that emitted a synthetic `reasoning`-typed tool
call. It looked correct at every layer — the text flowed through the adapter, the
stream, the tool events — and vanished at the final paint. A vestigial branch for
that shape still exists in the tool display normalizer, which makes reintroducing
it feel supported. It is not the render path. Emit `chunk.reasoning`.

To check that nothing has crept back in — this looks for the *construction* of a
reasoning-typed tool call, not the normalizer's read of one:

```bash
rg "type: ['\"]reasoning['\"]" src/services src/ui --type ts
```

Zero hits is the healthy state. Any hit is an adapter or service building the
shape that does not render.

## A provider may withhold reasoning unless the request asks for it
Every check above is about the response path. Before any of it can matter, the
**request** has to opt in — a model that thinks does not necessarily return what
it thought, and the two providers that stream summaries each have their own
switch:

| Provider | Request must carry |
|---|---|
| Google | `generationConfig.thinkingConfig.includeThoughts: true` — without it no part is ever marked `thought: true` |
| OpenAI | `reasoning.summary` (`'auto'`) on the Responses call |

This failure mode is invisible from the code: the adapter parses thought parts
correctly, the chain above is intact, and the chat bubble stays empty because the
data never arrives. It shipped exactly that way for Gemini, past a release note
claiming reasoning worked on every provider. No mocked lane can catch it — the
canned SSE body contains thought parts whatever the request asked for. The proof
is a live request; `tests/debug/google-reasoning-live-smoke.test.ts` is the
shape, and it asserts on the outbound body as well as the returned reasoning.

## Reasoning *level* for local providers is a decision, not a gap
The reasoning toggle and effort slider render only when the model's **static**
metadata advertises thinking support. Local providers discover their models at
runtime and have no static entry, so the control does not appear for them — and
neither local adapter sends an effort parameter anyway. One of them sends a plain
boolean "think" flag whose purpose is to keep reasoning out of the content stream,
which is a different thing from effort.

Users set reasoning effort in the local runtime's own UI. Do not build this
speculatively; if it is wanted, it is a product decision, not a missing wire.

Reasoning *rendering*, by contrast, does not depend on any capability heuristic:
an adapter routes its provider's native reasoning field to `chunk.reasoning`
whenever it appears, so a heuristic miss degrades gracefully.

## Related
- The stream option that carries it: `streaming-contract.md`.
- Capability flags and static model metadata belong to the `nexus-model-updates`
  skill, not here.
