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
request succeeded, the payload says it did not. `processNodeStream` handles this
only if `extractError` is supplied:

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
no adapter argument for the current inventory; at the time this skill was last
refined most streaming adapters were **not** wired, so a hosted provider producing
a blank bubble is a live possibility, not a hypothetical.

## Several stream processors, and only one honours extractError
`BaseAdapter` exposes more than one path and they are not interchangeable:

- **`processNodeStream`** — real incremental SSE over a Node readable stream, and
  **the only processor that actually consults `extractError`**. Every provider
  adapter in the tree streams through it.
- **`processBufferedSSEText`** / **`processSSEStream`** — the same option *type*
  applied to a buffered body or a `Response`. They accept `extractError` and never
  read it. Supplying it there buys nothing; the compiler will not tell you.
- **`processStream`** — a legacy fan-out over an iterable or a `Response` whose
  option type does not declare `extractError` at all.
- **`processNodeStreamJsonLines`** — for servers that emit one JSON object per
  line instead of SSE. Different option shape, its own done/chunk extractors, and
  no error extractor, so an error object on that path must be recognised inside
  the adapter's own chunk extractor.

Practical consequence: if you are not on `processNodeStream`, wiring
`extractError` is not the fix — recognising the error frame in your own extractor,
or moving to `processNodeStream`, is.

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
