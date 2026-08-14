---
name: nexus-llm-adapters
description: How to add or debug a Nexus LLM provider adapter — what every adapter must wire, how to verify it against a live provider, and the failure modes that produce a silently blank chat. Use when adding or changing a provider adapter, debugging streaming or reasoning display, working with local or CLI-backed models, or touching chat branch plumbing.
---

# Nexus LLM adapters

Adapters live in `src/services/llm/adapters/{provider}/` and extend `BaseAdapter`,
which talks direct HTTP through `ProviderHttpClient`. There are no vendor LLM SDKs
in this repo; adding one is a decision to raise, not to make.

This router points at the procedure. The detail loads when you take the path.

## Workflow
1. **Adding or changing an adapter** — follow `protocols/add-adapter.md`. It is a
   wiring checklist; work it in order rather than pattern-matching an existing
   adapter, because the pieces that get forgotten are the ones no compiler checks.
2. **Chat is blank, missing reasoning, looping, or doubling** — follow
   `protocols/debug-adapter.md`. Start from the symptom, not the adapter source:
   these failures have known causes and reading code first wastes the trip.
3. **Before calling any adapter change done** — run `protocols/verify-adapter.md`.
   You MUST exercise the non-streaming path, the streaming path, and the streaming
   *error* path separately; they fail independently and unit tests prove none of
   them. You MUST also run
   `scripts/check_stream_error_wiring.py` on the adapter you touched and get a
   zero exit.
4. **End of a session that used this skill** — run `protocols/self-refine.md`.

## Map
- `protocols/` the procedures: add-adapter, debug-adapter, verify-adapter,
  self-refine.
- `references/` mechanism and rationale, read on demand: `symptoms.md` (the
  symptom→cause lookup the debug protocol enters through), `streaming-contract.md`,
  `reasoning-rendering.md`, `local-providers.md`, `cli-providers.md`,
  `chat-plumbing.md`.
- `scripts/check_stream_error_wiring.py` — checks that an adapter parsing an SSE
  stream wires `extractError`. Run it, do not re-derive it by reading source.

## Siblings — do not duplicate them here
- **`nexus-model-updates`** owns model metadata: ids, pricing, context windows,
  capability flags, provider defaults, and the live provider smoke test.
- **`nexus-model-eval`** and **`nexus-eval-harness`** own grading models on tool use.
- **`nexus-testing`** owns test lanes, what a mock can prove, and the in-app loop.
- **`nexus-mobile-compat`** owns Node imports, dependency vetting, and desktop-only
  gating — which every adapter that shells out or touches the filesystem needs.

## Refine
At the end of a session that used this skill, run `protocols/self-refine.md` and
append to `refinement-log.md`.
