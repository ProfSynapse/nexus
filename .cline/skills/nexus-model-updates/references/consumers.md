# Who reads the registries, and what breaks

Read this when a model is present in a file but absent, mispriced or
under-featured in the app, and when deciding how much wiring a change needs.

## Key idea
There is no single model registry. Two aggregators import the same per-provider
arrays and feed different surfaces, and a third and fourth declaration of the
"default model" live outside both. Adding a model to an existing provider's array
reaches every consumer at once, because they all import that array. Adding a
*provider* reaches none of them until each is wired by hand.

## The two aggregators

**`src/services/llm/adapters/ModelRegistry.ts`** builds a provider→models map and
a provider→default map from the per-provider exports. It backs:
- cost calculation, which looks up the spec by provider and id;
- the `listModels()` implementation of adapters whose catalog is static;
- the default a provider resolves to when no model is given, which is what the
  live smoke lane reads;
- special-cased handling for providers whose models are discovered at runtime
  rather than declared.

**`src/services/StaticModelsService.ts`** converts the same arrays into the shape
the UI wants. It backs the model picker: the provider manager assembles available
models from this service, not from `ModelRegistry`. It registers each provider in
more than one place inside the file, so a provider can be half-wired here and
appear in one view but not another.

A registry imported by only one of the two is the failure this asymmetry
produces, and the gate reports it in the direction it occurred.

## The other places a default is written
Beyond a provider's `*_DEFAULT_MODEL` export:
- **the adapter constructor**, where some adapters pass the registry export and
  others hard-code the same literal. The literal wins at runtime.
- **the shipped settings defaults** under `src/types/`, which decide the
  provider/model a fresh install starts on, independently of any registry.
- **unit test expectations**, which pin specific ids and are the only automated
  notice that one of the above drifted.

`protocols/change-default.md` walks all of them; the gate compares the first two
and checks the shipped default against the registry.

## Symptom → cause

| Symptom | Cause |
|---|---|
| Model missing from the picker | Its array is not wired into the static models service, or the provider is not enabled in settings |
| Model in the picker, every call costs $0.00 | Cost lookup found no spec: the array is not in the central registry, or the id does not match `apiName` |
| Cost silently absent rather than wrong | Cost calculation returns null on an unknown model — there is no error path, the number just never appears |
| Reasoning toggle never appears for a reasoning model | `supportsThinking` is false or omitted; the control is skipped when the flag is not set |
| Model appears under the wrong provider | The entry's `provider` field disagrees with the directory it lives in |
| Two picker rows behave identically | Duplicate `apiName` in one registry with no adapter rule to disambiguate — lookup returns the first |
| App runs an old model after a default change | An adapter constructor literal, or the shipped settings default, still names the old id |
| Fresh install starts on a model that does not exist | The shipped settings default was never reconciled with the registry |
| Model list differs from the file | That provider refreshes its catalog from a listing endpoint; the static array is only the fallback |

## Providers without a static array
Locally-served and user-installed providers declare no `ModelSpec[]`. Their
models come from the adapter's `listModels()` against the running server, and the
central registry special-cases them to return nothing so the dynamic path is the
only one. Capability flags for those models are derived by the adapter — for
reasoning, from a name-matching heuristic in the shared adapter helpers, which
affects defaults and capability display only. `nexus-llm-adapters` owns that
path.
