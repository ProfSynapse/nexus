# The streaming contract

Context: read when wiring or debugging an adapter's stream. Covers what the shared
SSE processor can see, why `extractError` is load-bearing, and how the same code
behaves without a Node runtime.

## Key idea
The adapter does not parse the stream. It supplies a set of extractor callbacks —
`SSEStreamOptions` in `src/services/llm/streaming/SSEStreamProcessor.ts` — and the
shared processor in `BaseAdapter` drives them. **Anything you do not supply an
extractor for is invisible to the entire stack.** That is why an omission here
produces silence rather than an error.

## The extractors
Required by the type: content, tool calls, finish reason. Optional in the type:
usage, metadata, reasoning, error, parse-error handler.

`extractError` is optional in the type and mandatory in practice.

## Why extractError decides between an error and a blank bubble
Some providers deliver a fatal error as a data frame over **HTTP 200** — the
request succeeded, the payload says it did not. The processor handles this only
if `extractError` is supplied:

- With it: the message is recorded, the pump is drained, the final "complete"
  chunk is suppressed so no bogus success is emitted, and a `LLMProviderError`
  carrying a stream-error code is thrown after the drain. The caller can react —
  this is how the local-provider draft-model retry works.
- Without it: the frame is just an unrecognised object. Nothing matches, the
  stream reaches its end, the generator returns normally. The user sees an empty
  bubble and the log has nothing in it.

An empty stream is never an acceptable outcome. If a provider's error frame shape
is unknown, map it approximately and fail loudly rather than returning nothing.

`scripts/check_stream_error_wiring.py` checks this mechanically. Run it rather
than reading adapters to find out who is covered — the answer changes. Run it with
no adapter argument for the current inventory, or `--strict` to gate the tree.

## Every processor honours extractError the same way
`BaseAdapter` exposes several paths. They differ in *transport*, not in what the
option means — supplying `extractError` behaves identically on all of them:

- **`processNodeStream`** — real incremental SSE over a Node readable stream.
  Most provider adapters stream through it.
- **`processBufferedSSEText`** / **`processSSEStream`** — the same SSE frames from
  a buffered body or a `Response`.
- **`processStream`** — fan-out over an iterable or a `Response`; its option type
  declares `extractError` and both branches consult it.
- **`processNodeStreamJsonLines`** — one JSON object per line instead of SSE
  (Ollama). Different option shape, same optional `extractError`.

All of them raise the same `LLMProviderError` with `PROVIDER_STREAM_ERROR`, built
by `createProviderStreamError` in
`src/services/llm/streaming/streamErrorFrames.ts`.

Adapters that hand-roll their own `createParser` loop rather than using a shared
processor — the OpenAI Responses family (OpenAI, Codex, Copilot's `/responses`) —
meet the same obligation by calling `extractStreamErrorMessage` or
`extractResponsesApiStreamError` from that module and throwing after the drain.

## The shared extractors
`streamErrorFrames.ts` provides the two shapes worth reusing:

- **`extractStreamErrorMessage(frame, fallback)`** — a top-level `error` member
  (object or string) or Mistral's `{"object":"error","message":...}`. Correct for
  every OpenAI-compatible surface, Google's `google.rpc.Status` frame, and
  Ollama's NDJSON error line. Deliberately narrow: it cannot fire on a content
  frame.
- **`extractResponsesApiStreamError(event, fallback)`** — the Responses API's
  `{"type":"error"}` and `{"type":"response.failed"}` events.
  `response.incomplete` is *not* an error: truncated output is still output.

Provider-specific quirks stay in the adapter — Groq nests failures under
`x_groq.error`, Google's blocked prompts arrive as `promptFeedback.blockReason`
with no candidates, Anthropic's error is an `error` *event type*.

## Tool call accumulation
When `accumulateToolCalls` is on, the processor assembles streamed fragments by
index, concatenating argument deltas, and yields progress on an interval. It
synthesizes an id when the provider omits one, because downstream APIs reject a
tool result whose call id is empty. Do not re-implement this per adapter.

## Mobile changes the shape, not the code
`ProviderHttpClient.requestStream()` falls back, when there is no desktop Node
runtime, to a buffered `requestUrl` response wrapped as a single-chunk async
iterable. The adapter code is identical; the user experience is one blob at the
end. So "streaming verified" on desktop says nothing about the phone, and any
timing assumption that only holds mid-stream will not hold there.

## Related
- Reasoning has its own channel and its own trap: `reasoning-rendering.md`.
- Local servers put errors in the stream far more often than hosted ones:
  `local-providers.md`.
