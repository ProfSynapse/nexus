# Symptoms → mechanism

Context: the entry point for `protocols/debug-adapter.md`. Each row is a failure
that has actually happened in this codebase, phrased the way it presents, with the
mechanism behind it and where the explanation lives. Match the symptom before
theorising.

## Key idea
Nearly every adapter bug in Nexus presents as *absence* — no text, no reasoning,
no error — because the streaming stack's default on an unhandled condition is to
end quietly. Treat missing output as a swallowed failure until proven otherwise.

## Lookup

| Symptom | Mechanism | Read |
|---|---|---|
| Chat bubble is blank and **nothing was logged** | The stream ended without emitting. Almost always a provider error frame delivered over HTTP 200 with no `extractError` wired, so the pump drained and the generator returned. | `streaming-contract.md` |
| Reasoning is visibly in the provider payload but never appears in the UI | Something routed reasoning through a synthetic `reasoning`-typed tool call instead of `chunk.reasoning` → `onReasoningUpdate`. The text survives every layer and is lost at the final paint, because the bubble re-renders from the message's `reasoning` field. | `reasoning-rendering.md` |
| Thinking is enabled and normal answer text appears, but there is no Thinking block | The provider changed or varies its dedicated reasoning field name and the adapter extracts only one shape. LM Studio, for example, has emitted both `reasoning` and `reasoning_content` on otherwise identical Chat Completions payloads. | `reasoning-rendering.md` |
| Thinking is enabled on a newer hosted model, but its Thinking block is empty or the request is rejected | The request control changed independently of the response format. Check the model generation: newer models may require adaptive/effort controls or an explicit summarized-display setting while older models still require a token budget. | `reasoning-rendering.md` |
| No reasoning-effort control for a local model | Deliberate. The control is gated on *static* model metadata advertising thinking support; local models are discovered at runtime, and neither local adapter sends an effort parameter. Not a gap — do not build it speculatively. | `reasoning-rendering.md` |
| The model reloads on **every single message** | A load-parameter comparison that can never converge. The classic is `flash_attention`: MLX silently no-ops it and never reports it back, so a reload is triggered forever. | `local-providers.md` |
| Context looks available in Nexus, but the local runtime truncates, runs out of memory, or compaction never fires | The adapter exposed a declared/default context instead of the context the runtime actually allocated, or the provider never entered the compaction budget path. Load the model at the requested context, read back the reported allocation, and feed that same value into model metadata and compaction. | `local-providers.md` |
| Chat produces no output **only when speculative decoding is on** | The draft model is incompatible with the target backend and the rejection arrived as an in-stream frame, not an HTTP error. A detect-drop-retry fallback exists; confirm it was not bypassed. | `local-providers.md` |
| A tool ran twice, with visible side effects | Something re-executed `chunk.toolCalls` on a subagent path. Those calls are already executed and carry their results; the ping-pong ran upstream. | `chat-plumbing.md` |
| A tool works once, then the same tool later reports an operation-ID conflict or returns stale output | A provider- or adapter-synthesized response-local tool-call id was promoted directly to a durable receipt id and repeated on a later response. Scope it with the turn/response identity before the receipt boundary. | `streaming-contract.md` |
| The branch type the UI shows is not the one that was stored | Two different vocabularies at a layer boundary. The stored set and the view-layer union are not the same, and the conversion collapses everything that is not a subagent into the view's generic value. | `chat-plumbing.md` |
| The CLI provider accepted a model name that was never configured | The CLI fails *open* on an unknown model and silently substitutes a default. Nexus closes it with a fail-closed allowlist. Do not relax that into a warning. | `cli-providers.md` |
| Chat spinner never resolves against a CLI provider | A wedged child process. There are two independent bounds — the shared runner's inactivity watchdog and the provider's own timeout flag — and neither implies the other. Check which one applies before changing either. | `cli-providers.md` |
| Streaming works on desktop, single blob on mobile | Expected. Without a Node runtime, `requestStream()` falls back to a buffered request wrapped as a one-chunk stream. | `streaming-contract.md` |

## When the symptom is not here
Debug it, fix it, then add the row. `protocols/self-refine.md` step 2 exists for
exactly this, and it is the most valuable thing this skill can accumulate.
