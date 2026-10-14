# Protocol: add-video-model

Context: video generation models are in neither `<Provider>Models.ts` nor
an image adapter. One static array, `VIDEO_MODELS` in
`src/services/llm/types/VideoTypes.ts`, holds them. It decides what the video
settings offer and what `generateVideo` accepts. A model missing from that
array is rejected, even when the provider's live listing has it. The
`generateVideo` tool schema carries no model enum, so tool catalogs do not
change, and the structural gate does not see these entries either.

## Mission
A catalog entry that sends only aspect ratios, resolutions and durations the
provider accepts, on a transport the adapter already uses.

## Steps

1. **Check the transport first.** `GoogleVideoAdapter` uses
   `models/<id>:predictLongRunning`. Google's newer video models are served
   only by the Interactions API (`POST /v1beta/interactions`), and that is
   new adapter work, not a catalog entry. `OpenRouterVideoAdapter` speaks
   OpenRouter's unified `POST /api/v1/videos`, so any model in its video
   catalog uses the same request shape.

2. **Source the facts.**

   ```bash
   curl -s https://openrouter.ai/api/v1/videos/models | python3 -c '
   import json,sys
   for m in json.load(sys.stdin)["data"]:
       print(m["id"], m.get("supported_resolutions"), m.get("supported_aspect_ratios"),
             m.get("supported_durations"), "audio", m.get("generate_audio"),
             "frames", m.get("supported_frame_images"))'
   ```

   For Google direct, the parameter table on ai.google.dev/gemini-api/docs/video
   is the source, and `/docs/deprecations` gives shutdown dates. Read it per
   model: Veo on the Gemini API accepts `16:9`/`9:16` only, even though other
   routes add `1:1`.

3. **Fit the entry to the unions.** `VideoAspectRatio` and `VideoResolution`
   are narrow, closed unions. Declare the intersection of the listing and the
   union. A model with no value in the intersection (for example a `2K`-only
   model) needs a type change and is not a catalog-only addition. OpenRouter's
   resolution enum is case-sensitive (`4K`), and the adapter maps the internal
   `4k` to it. Keep that mapping when you touch `submitJob`.

4. **`supportsReferenceImage` means `input_references`** (reference-to-video)
   on OpenRouter, not a first-frame image. A model whose listing names only
   `supported_frame_images` and whose vendor does not document reference
   images gets `false`.

5. **Defaults.** `resolveDefaultVideoSelection` falls back to the first entry of
   the first configured provider in `VIDEO_PROVIDER_PRIORITY`, and the shipped
   `defaultVideoModel` in `src/types/llm/ProviderTypes.ts` is an independent
   value. Keep each provider's first entry stable unless you mean to move the
   fallback. When the shipped default moves, the `shipped video default` test in
   `tests/unit/VideoGenerationService.test.ts` must still pass.

6. **Live call.** `tests/debug/video-generation-live-smoke.test.ts` drives the
   real adapters. Video generation is billed per second, so run it only with
   the owner's go-ahead. Without that run, report the entry as unverified.

## Next
`verify-model.md` steps 1–3, then `self-refine.md`.
