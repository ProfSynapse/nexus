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

1. **Check the transport first.** `GoogleVideoAdapter` speaks Google's
   Interactions API (`POST /v1beta/interactions` with `background: true`, then
   `GET /v1beta/interactions/{id}`), which is how Gemini Omni Flash is served.
   A Google video model on another surface (Veo's `predictLongRunning`, or a
   Vertex-only id) is new adapter work, not a catalog entry.
   `OpenRouterVideoAdapter` speaks OpenRouter's unified `POST /api/v1/videos`,
   so any model in its video catalog uses the same request shape.

2. **Source the facts.**

   ```bash
   curl -s https://openrouter.ai/api/v1/videos/models | python3 -c '
   import json,sys
   for m in json.load(sys.stdin)["data"]:
       print(m["id"], m.get("supported_resolutions"), m.get("supported_aspect_ratios"),
             m.get("supported_durations"), "audio", m.get("generate_audio"),
             "frames", m.get("supported_frame_images"))'
   ```

   For Google direct, the model's guide (for Omni, ai.google.dev/gemini-api/docs/omni)
   and the `VideoResponseFormat` schema in
   https://ai.google.dev/static/api/interactions.openapi.json are the source,
   and `/docs/deprecations` gives shutdown dates. Omni accepts `16:9`/`9:16`
   only and a `duration` in google-duration format (`"8s"`).

3. **Fit the entry to the unions.** `VideoAspectRatio` and `VideoResolution`
   are narrow, closed unions (`360p` exists for Omni; OpenRouter's parser
   still drops it). Declare the intersection of the listing and the union. A model with no value in the intersection (for example a `2K`-only
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
   real adapters (OpenRouter by default; add `VIDEO_SMOKE_GOOGLE=1` and a
   `GEMINI_API_KEY` for Gemini Omni Flash — see the file header). Video generation is billed per second, so run it only with
   the owner's go-ahead. Without that run, report the entry as unverified.

7. **Retiring a model.** Remove its entry and add it to
   `src/services/llm/types/RetiredMediaModels.ts` with the provider-documented
   successor. Saved defaults, conversations and tool calls that still name it
   are mapped there at load and call time; the catalog alone would turn them
   into "not available" errors.

## Next
`verify-model.md` steps 1–3, then `self-refine.md`.
