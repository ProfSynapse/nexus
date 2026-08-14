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

## Reasoning effort
Not wired for local providers, deliberately. See `reasoning-rendering.md`.

## Verification
Local servers are not covered by the live smoke lane. Verify them by hand through
all three paths in `protocols/verify-adapter.md`.
