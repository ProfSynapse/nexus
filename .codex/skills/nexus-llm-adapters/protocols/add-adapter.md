# Protocol: add-adapter

Context: you are adding a new LLM provider adapter, or changing an existing one
enough that its wiring is in question. TypeScript will catch a missing abstract
member; it will not catch a provider the settings UI never offers, a stream that
ends silently, or a desktop-only adapter that crashes a phone.

## Mission
An adapter that is reachable from the UI, streams correctly, fails loudly, and is
gated for the platforms it can actually run on.

## Steps

1. **Choose the transport.** HTTP providers go through `BaseAdapter.request()` for
   buffered calls and `BaseAdapter.requestStream()` for streaming. You MUST NOT add
   a vendor LLM SDK to `package.json` — none are used and adding one is a decision
   to raise with the user. If the provider is a local server or a CLI, read
   `references/local-providers.md` or `references/cli-providers.md` first; both
   carry constraints that change the design.

2. **Implement the `BaseAdapter` surface.** The abstract members are `name`,
   `baseUrl`, `generateUncached`, `generateStreamAsync`, `listModels`,
   `getCapabilities`, `getModelPricing`. Read the class before filling them —
   `generate()` wraps `generateUncached()` with caching, so caching-sensitive
   inputs that are not part of the default key (a reasoning-effort setting, for
   example) require overriding `generateCacheKey`.

3. **Wire the stream.** Read `references/streaming-contract.md`. Every extractor you
   supply defines what the shared processor can see. `extractError` is the one that
   is optional in the type and mandatory in practice: without it a provider error
   frame delivered over HTTP 200 ends the stream with no output and no log. An
   empty stream is NEVER an acceptable outcome — if you cannot map the provider's
   error frame shape, fail loudly instead of returning nothing.

4. **Route reasoning through the chunk, not a tool call.** Read
   `references/reasoning-rendering.md`. Emit `chunk.reasoning` from the stream and
   let the existing chain render it. You MUST NOT introduce a synthetic
   `reasoning`-typed tool call; that path loses the text at the final paint.

5. **Find every wiring point by tracing an existing provider, not from a list.**
   Pick any id already in the `SupportedProvider` union in
   `src/services/llm/adapters/types.ts` that resembles yours, then:

   ```bash
   rg -l "'<that-provider-id>'" src/ --type ts
   ```

   Walk each hit and decide whether your provider needs an entry. The hits span
   adapter construction, the supported-provider union, platform compatibility,
   settings, validation, display naming, and static model registration. Trace it
   fresh each time — a checklist of file paths here would be wrong within a
   release.

6. **Hand model metadata to the sibling skill.** Model ids, pricing, context
   windows, capability flags and provider defaults belong to `nexus-model-updates`.
   Do not invent them here.

7. **Gate the platform.** `isProviderCompatible()` in `src/utils/platform.ts`
   decides where a provider is offered. Anything that spawns a process, reads the
   filesystem, or imports a Node built-in is desktop-only and MUST be gated —
   this plugin ships to mobile, and a top-level Node import crashes the whole
   plugin before any runtime guard runs. Load `nexus-mobile-compat` before writing
   such an adapter.

8. **Verify.** Run `protocols/verify-adapter.md`. An adapter that compiles and has
   never spoken to the provider is not done.

## Guidelines
- Pattern: copy the *shape* of the nearest existing adapter, then work this
  checklist against it. Copying alone reproduces whatever that adapter forgot.
- Pattern: when the provider is OpenAI-compatible, reach for the helpers in
  `src/services/llm/adapters/shared/` before writing extraction logic again.
- Anti-pattern: treating "it produced text once in chat" as verification. That
  exercises one of three paths.
- Anti-pattern: adding a provider-level capability flag to express a limitation
  the app enforces elsewhere. Check where the existing seam lives before adding a
  new switch.

## Next
`protocols/verify-adapter.md`. Nothing here counts as done until that protocol
exits clean.
