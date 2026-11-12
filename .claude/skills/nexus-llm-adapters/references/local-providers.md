# Local model servers

Context: read when working on an adapter for a local runtime, or when a local
model misbehaves in a way no hosted provider does. These servers are where the
undocumented behaviour lives, and several defences in the adapters exist only
because of it.

## Key idea
A local runtime's public REST documentation is not a description of its
behaviour. Parameters that are documented get ignored per backend engine,
parameters that are undocumented are honoured, and fatal conditions arrive as
in-stream frames rather than HTTP errors. Verify against the running server, and
treat every workaround already in the adapter as load-bearing until proven
otherwise.

## Curl before you blame the adapter
Reproduce against the server directly first. If curl shows the same thing, the
adapter is not the bug and the fix is a request-shape change or a defence, not a
parsing change.

## Speculative decoding fails per backend, and says so mid-stream
A draft model paired with a batched target on the MLX engine is rejected, and the
rejection can arrive as an error frame over an HTTP 200 stream rather than an HTTP
error. The adapter's shape, which must survive refactors:

1. Attach the draft model per request, unless this exact (target, draft) pair was
   already rejected.
2. Detect a draft/speculative rejection — from HTTP *or* in-stream, via
   `extractError` — that occurs **before any real output**.
3. Drop the draft, remember the pair as incompatible so it is not retried
   forever, notify the user once with the reason, and retry without speculative
   decoding.

The point of the fallback is that chat always produces something. Removing it
turns a degraded response into a blank one. GGUF targets have no equivalent
restriction; pair one with a same-family GGUF draft so the vocabularies match.

Inducing this rejection on purpose is the easiest way to exercise the streaming
error path in `protocols/verify-adapter.md`.

## Never compare a parameter the engine does not report back
Before chatting, the adapter scans the server's loaded instances and reloads only
when none is suitable. The comparison is what makes that cheap — and what can make
it infinite.

`flash_attention` is the documented example: it affects one engine only, the other
silently no-ops it and never echoes it back. Include it in a reuse comparison and
the loaded instance never matches the desired config, so every single message
triggers a full model reload. Pass it through, never diff it.

The generalisation: **only compare load parameters the server actually reports on
a loaded instance.** Context length is safe because it is echoed. A parameter that
is honoured but not echoed (one local server honours a `parallel` setting that its
public docs omit) can be *required* in the match but only when you know the server
reports it.

The whole path is best-effort by design: any failure falls through to the server's
just-in-time loading so chat is never blocked.

## Runtime context is the budget, not the model's claim
A model's native maximum, a configured context request, and the context the local
runtime actually allocated are three different numbers. Publishing a generous
fallback as `ModelInfo.contextWindow` makes the context badge and pre-send
compaction gate fail together: Nexus believes space remains while the runtime is
already truncating or out of memory.

For a configurable local runtime, keep one source of truth:

1. Request the chosen context when loading or generating.
2. Read back the loaded instance's reported context allocation.
3. Publish that allocation in model metadata and update the compaction budget
   from the same value.
4. If the runtime cannot report it yet, use the explicit configured value or a
   conservative fallback, never the model's theoretical maximum.

Server-wide performance controls are not request controls. Flash attention and
KV-cache format may require environment changes and a server restart, and can
affect other applications sharing the runtime. Detect and explain them; do not
silently mutate a user-owned server. A Nexus-owned runtime may apply a validated
profile, but still verify the resulting allocation rather than assuming the
setting was honored.

## Reasoning effort
Not wired for local providers, deliberately. See `reasoning-rendering.md`.

## Verification
Local servers are not covered by the live smoke lane. Verify them by hand through
all three paths in `protocols/verify-adapter.md`.

## Where an OpenAI-compatible server says its context
`/v1/models` has no standard limit field. Read, in order: `max_model_len`
(vLLM, SGLang), `context_length` (OpenRouter, Together, Bifrost),
`context_window` (Groq, Bifrost's OpenAI route), `max_context_length`
(Mistral, LM Studio native), `top_provider.context_length`. llama.cpp's
`meta.n_ctx_train` is the trained maximum; the allocated per-slot context is
`default_generation_settings.n_ctx` on `/props`, served beside `/v1`, not under
it. Gateways can strip all of this: Bifrost re-serves custom upstreams as bare
`{id, created, owned_by}`, so a user-entered value must always be possible.

Over-long prompts fail fast and name the limit. vLLM: HTTP 400 "This model's
maximum context length is N tokens". llama.cpp: HTTP 400 with
`error.type: exceed_context_size_error`, `error.n_ctx`, and the message
"request (X tokens) exceeds the available context size (N tokens)". A server
that truncates instead of refusing shows up only as a low
`usage.prompt_tokens`, and that count is not its context: Ollama 0.40 (llama.cpp
runner, `num_ctx` 32,768) kept 16,386 tokens of any longer prompt, so never offer
it as the size. Ollama's `/v1/models` reports no context at all, and its MLX
runner accepted 49,140 tokens with `num_ctx` 32,768. `tests/debug/openai-compatible-context-live.test.ts`
exercises all of this against a real server; for Ollama set
`COMPATIBLE_CONTEXT_OVERSIZE=truncated COMPATIBLE_CONTEXT_REPORTED=none`.

A chat stores its budget beside the model's whole window at that time
(`chatSettings.modelContextWindow`). When the window later grows, a budget equal
to the old window follows it, on reopen and in an open chat; a smaller one stays.
Chats saved before that field existed are treated as "whole window" only at the
OpenAI-compatible 4,096 fallback.
