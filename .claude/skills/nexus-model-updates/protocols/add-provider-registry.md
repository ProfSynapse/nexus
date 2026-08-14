# Protocol: add-provider-registry

Context: a provider is being added and needs a model catalog, **or** an existing
provider turned out to be wired into only one aggregator and needs the other.
The adapter itself — transport, streaming, settings registration, platform
gating — belongs to `nexus-llm-adapters`; this protocol covers only the catalog
and the two aggregators that read it. A registry that exists but is wired into
neither aggregator compiles cleanly and is invisible at runtime; one wired into
only a single aggregator is worse, because it works well enough that nobody looks.

For the repair case, skip to the wiring step for whichever aggregator the gate
named and run the gate again. `references/consumers.md` says what each one drives,
so you can predict the symptom the repair should make go away.

## Mission
A provider whose models appear in the picker, price correctly, and resolve a
default.

## Steps

1. **Decide whether the provider needs a static catalog at all.** Providers whose
   models are discovered from a running server or a user's installation do not
   get a `ModelSpec[]` array; they are special-cased in the aggregator and their
   models arrive from the adapter's `listModels()`. `references/consumers.md`
   describes both shapes. Ask which one this provider is before writing a file.

2. **Create `src/services/llm/adapters/<provider>/<Provider>Models.ts`.** Export
   an array typed `ModelSpec[]` and a `<PROVIDER>_DEFAULT_MODEL` string. Use the
   directory name as the `provider` value on every entry — the aggregators label
   a model from that field, not from the key they filed it under, so a mismatch
   sends it to the wrong provider in the UI. Field rules are in
   `references/registry-anatomy.md`.

3. **Wire the central registry.** In `src/services/llm/adapters/ModelRegistry.ts`:
   import both exports, add the array to the `AI_MODELS` map, and add the default
   to the `DEFAULT_MODELS` map. This is what cost calculation and the adapters'
   own `listModels()` read, and what the live smoke lane resolves a default from.

4. **Wire the static models service.** In `src/services/StaticModelsService.ts`
   the same array has to be registered in more than one place — read the file and
   add an entry everywhere the existing providers appear. This is what the model
   picker reads. Missing one of the sites yields a provider that is half-present:
   models in one view, absent in another.

5. **Run the gate.** It reports a registry wired into one aggregator and not the
   other, which is the exact failure this step exists to catch:

   ```bash
   python3 .claude/skills/nexus-model-updates/scripts/check_model_registry.py \
     --repo-root . --strict <provider>
   ```

6. **Hand the rest back.** Adapter construction, the supported-provider union,
   platform compatibility, settings and display naming are `nexus-llm-adapters`'
   checklist. Do not reconstruct it here; it changes independently of the model
   catalog.

7. **Verify.** Go to `verify-model.md`.

## Guidelines
- Pattern: seed the registry with one model, get it end-to-end green, then add
  the rest. A catalog of twelve unverified ids is twelve unverified ids.
- Pattern: check whether the adapter refreshes its catalog from a listing
  endpoint. If it does, the static array is a fallback for first paint and its
  ids need to be slugs the provider still accepts, not aspirational names.
- Anti-pattern: registering the array in one aggregator because that made the
  symptom in front of you go away. The two feed different surfaces and both are
  user-visible.

## Next
`verify-model.md`.
