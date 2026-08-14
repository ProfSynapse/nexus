# Protocol: verify-adapter

Context: the adapter compiles and the unit lane is green. Neither fact tells you
whether the provider accepts your request shape, whether the stream terminates, or
whether an error becomes visible. Only traffic against a real endpoint does.

## Mission
Prove an adapter change on all three request paths against a live provider.

## Steps

1. **Run the wiring gate.** From the repo root:

   ```bash
   python3 .claude/skills/nexus-llm-adapters/scripts/check_stream_error_wiring.py \
     --repo-root . <provider-dir>
   ```

   Exit 1 means the adapter parses an SSE stream without `extractError`. Stop and
   fix it — everything below will pass anyway and the silent-failure mode ships.
   Run it with no adapter argument for a current inventory of the whole tree.

2. **Exercise the non-streaming path.** A completion through `generateUncached`
   with the real key or local server. Confirm text, and confirm usage/cost land if
   the provider reports them.

3. **Exercise the streaming path.** A completion through `generateStreamAsync`.
   Confirm incremental chunks arrive, the final chunk is marked complete, and tool
   calls (if the provider supports them) accumulate into well-formed calls.

4. **Exercise the streaming *error* path deliberately.** You MUST trigger a
   mid-stream failure and confirm it surfaces as a thrown error rather than an
   empty stream — this is the path that fails silently, so it is the one nobody
   tests by accident. Ways to induce one: point at a model id the provider will
   reject, send a parameter it refuses, or on a local server configure an
   incompatible speculative-decoding draft (see `references/local-providers.md`).

5. **Run the live smoke lane where it covers your provider.**
   `tests/debug/provider-model-live-smoke.test.ts` drives real model ids against
   real endpoints and is skipped unless explicitly enabled. Its file header holds
   the authoritative invocation and env-var names; read it rather than trusting a
   copy. The shape is:

   ```bash
   RUN_MODEL_SMOKE=1 MODEL_SMOKE_PROVIDER=<id> MODEL_SMOKE_MODEL=<id> \
     npx jest tests/debug/provider-model-live-smoke.test.ts --runInBand --no-coverage
   ```

   The provider union declared in that file is what it actually covers; local
   servers and CLI providers are not in it, so verify those by hand per steps 2–4.
   `nexus-model-updates` wraps this lane for model-metadata work.

6. **Verify on mobile if the provider is offered there.** `requestStream()` falls
   back to a single buffered chunk where there is no Node runtime, so a streaming
   path proven on desktop proves nothing about the phone. `nexus-mobile-compat`
   covers the rest of that check.

7. **Run the standard test lanes.** `nexus-testing` owns which lane to use, what a
   mock can and cannot prove, and the in-app loop for driving the running plugin.

## Guidelines
- Pattern: verify against the cheapest model the provider offers. You are testing
  transport, not intelligence.
- Pattern: keep the induced error from step 4 in your notes. It is the fastest
  reproduction next time.
- Anti-pattern: reporting success from a green unit suite. Mocks answer with
  whatever shape you wrote into them, which is exactly the assumption under test.
- Anti-pattern: skipping step 4 because steps 2 and 3 passed. Silent-stream bugs
  are invisible in a passing happy path by construction.

## Next
`protocols/self-refine.md` at the end of the session. If verification failed,
return to `protocols/add-adapter.md` or `protocols/debug-adapter.md` and re-enter
here.
