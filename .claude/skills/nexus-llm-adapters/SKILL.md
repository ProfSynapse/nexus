---
name: nexus-llm-adapters
description: How to add or debug a Nexus LLM provider adapter — what every adapter must wire, how to verify it against a live provider, and the failure modes that produce a silently blank chat. Use when adding or changing a provider adapter, debugging streaming or reasoning display, working with local or CLI-backed models, or touching chat branch plumbing.
---

# Working on LLM Adapters

Providers talk direct HTTP through `ProviderHttpClient`, reached via
`BaseAdapter.request()` / `requestStream()`. There are no vendor LLM SDKs in
`package.json` and adding one is a decision to raise, not to make. Adapters live in
`src/services/llm/adapters/{provider}/` over `BaseAdapter`.

## What every streaming adapter must wire

**`extractError` on `SSEStreamOptions`.** Some providers return `{"error":{...}}`
frames **over HTTP 200**. Without an extractor the stream simply ends, the user gets
a blank bubble, and nothing is logged — the worst failure shape available. With it,
`processNodeStream` records the message, drains the pump and throws a
`LLMProviderError` with a stream-error code, so no bogus "complete" chunk is emitted.

An empty stream is never an acceptable outcome. If you cannot map a provider's error
frame, fail loudly rather than returning nothing.

**Reasoning goes through the event, not a fake tool call.** Emit `chunk.reasoning`
and let the existing chain carry it: `onReasoningUpdate(messageId, text, isComplete)`
on the stream/message events → `ChatView` → `MessageDisplay` → `MessageBubble`,
which renders a collapsible block that auto-expands while streaming. Do **not**
reintroduce a synthetic `reasoning`-type tool call — that was the previous mechanism
and the tool coordinator never rendered it, so reasoning flowed correctly through
every layer and vanished at the final paint.

## Verify a new or changed adapter

Unit tests cannot tell you whether a provider actually accepts your request shape.
The lanes that can:

- `tests/debug/provider-model-live-smoke.test.ts` — drives real model ids against
  the real endpoint. Use it when adding a provider or changing model metadata; the
  `nexus-model-updates` skill wraps this.
- For a local server, curl it directly before blaming the adapter. Local runtimes
  return in-stream errors and undocumented behaviours that no fixture will predict.

Check three things explicitly, because they fail independently: the non-streaming
path, the streaming path, and the streaming **error** path (send something the
provider will reject mid-stream and confirm you get an error rather than silence).

## Local models

Local runtimes are where the undocumented behaviour lives.

**Speculative decoding can fail per-backend.** A draft model against a batched MLX
target is rejected — and the rejection may arrive as an in-stream frame rather than
an HTTP error. `LMStudioAdapter` handles this by detecting the failure before any
real output, marking the draft incompatible, dropping it and retrying, so chat
always produces something. Preserve that fallback shape if you touch it. GGUF
targets have no such restriction; pair one with a same-family GGUF draft so the
vocab matches.

**Do not compare `flash_attention` when deciding whether a loaded model is
reusable.** It is llama.cpp-only, MLX silently no-ops it and does not report it
back, so the comparison never converges and the adapter reloads the model forever.
Pass it through; never diff it. The loaded-instance scan matches on context length,
plus a non-batched instance when a draft is configured.

**Reasoning *level* is deliberately not wired for local providers.** The control
only renders for models whose static metadata advertises thinking support, local
providers have no such entry, and neither local adapter sends an effort parameter.
This is a decision, not a gap: users set reasoning effort in LM Studio's own UI. Do
not build it speculatively.

## CLI-backed providers

One provider shells out to a CLI (`agy`, under the historical `google-gemini-cli`
provider id, which stays unchanged for settings compatibility). Its contract is
narrower than an HTTP provider's: plain-text output, no token usage, text completion
only — no tool calling.

**Security constraints, non-negotiable:**

- The auth probe is **boolean-only**. It may read the credentials file to test for a
  non-empty token, and must return only a boolean or exit code. The token value is
  never captured, logged, or returned.
- No persistent writes into the user's provider config directory.
- No permission-skipping flags.
- Model selection is a **fail-closed allowlist**. The CLI fails *open* on an unknown
  model — it will happily run something you did not intend — so Nexus must reject
  anything outside the known set. Keep that direction if you touch the normalizer.
- Provider API keys are stripped from the child environment so the CLI can only use
  its own file-based auth.

Anything shelling out inherits the shared CLI process runner and its idle watchdog;
do not assume a provider-specific timeout flag is the only bound on a hung process.

## Chat branches

A branch **is** a conversation with parent metadata — `parentConversationId`,
`parentMessageId`, `branchType`.

⚠️ **Two vocabularies, don't conflate them.** The *stored* branch type and the
*view-layer* union are different sets, and the conversion collapses anything that
is not a subagent into the view's generic value. So a value you stored may not be
the value the UI reports. Read both the storage types and the view types before
assuming a mismatch is a bug — it is a layer boundary.

**Subagent tool calls are already executed.** The `chunk.toolCalls` a subagent
executor sees carry their results; the ping-pong ran inside `LLMService`. Consume
them for display and status only — re-executing them runs the side effects twice.

## Gotchas

**"The chat bubble is blank and nothing was logged."** The stream ended without
emitting. Almost always a provider error frame over HTTP 200 with no `extractError`
wired.

**"Reasoning is in the payload but never appears in the UI."** Something is emitting
a synthetic reasoning tool call instead of `onReasoningUpdate`. The tool coordinator
does not render it.

**"The model reloads on every single message."** A load-parameter comparison that
can never match — check `flash_attention` first.

**"Chat produces no output only when speculative decoding is on."** The draft model
is incompatible with the target backend and the error arrived in-stream. The retry
path exists; confirm it was not bypassed.

**"A tool ran twice."** Something re-executed `chunk.toolCalls` in a subagent path.

**"The CLI provider accepted a model name I never configured."** The CLI fails open;
the allowlist is what closes it. Do not relax it into a warning.

## Related skills

Model metadata (ids, pricing, context windows, capabilities, defaults) and the live
provider smoke test: `nexus-model-updates`. Grading models on tool use:
`nexus-model-eval`.
