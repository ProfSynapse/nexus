# Protocol: add-image-model

Context: image generation models do not live in `<Provider>Models.ts` and the
structural gate does not see them. Each image adapter carries its own catalog —
`src/services/llm/adapters/openrouter/OpenRouterImageAdapter.ts` (`modelSpecs`),
`src/services/llm/adapters/google/GeminiImageAdapter.ts` and
`src/services/llm/adapters/openai/OpenAIImageAdapter.ts` — and the internal
ids are also enumerated in the `ImageModel` union in
`src/services/llm/types/ImageTypes.ts`. The `generateImage` tool builds its model
enum at runtime from the adapters, but the committed tool catalogs embed that
enum, so a model addition without a catalog regeneration fails `schemas:check`.

## Mission
An image model entry whose transport parameters are the ones the provider's
endpoint actually accepts, proven by one live generation through the adapter.

## Steps

1. **Pick the transport before the entry.** OpenRouter serves image models on
   a dedicated Image API (`POST /api/v1/images`) and adds new image models there
   only. The chat-completions route (`modalities: ['image','text']`) serves
   Google/OpenAI text+image models and 404s for every image-only model. The
   OpenRouter image adapter speaks the Image API; a model in its catalog is a
   one-entry addition. Google direct goes through `generateContent`; only Gemini
   image models belong there.

2. **Source the facts from the provider's own catalog, not from another entry.**

   ```bash
   # everything OpenRouter serves as an image model
   curl -s https://openrouter.ai/api/v1/images/models | python3 -c \
     "import json,sys; [print(m['id']) for m in json.load(sys.stdin)['data']]"
   # one model's accepted parameters and per-image pricing
   curl -s https://openrouter.ai/api/v1/images/models/<vendor>/<model>/endpoints
   ```

   Copy `resolution` values, `input_references.max` and the pricing unit exactly
   into the entry. On this API an unsupported parameter is a hard 400 naming the
   parameter, not a silent ignore, so `resolutions: null` means "never send
   one". Gemini endpoints bill per output token; a 1K image is 1120 tokens, so
   the per-image figure is 1120 × the `output_image` token price. FLUX bills per
   megapixel. Never send `n` unless the endpoint lists it.

3. **Write the entry and the union member.** The `ImageModel` union in
   `ImageTypes.ts` must list the internal id or `supportedModels` will not
   compile. Internal ids are provider-neutral (`gemini-2.5-flash-image` is one
   id across Google direct and OpenRouter) — reuse an existing internal id when
   the same model already exists on another provider.

4. **Regenerate the committed tool catalogs.**

   ```bash
   npm run schemas:tools && npm run schemas:check
   ```

   Only the model enum and a `generatedAt` stamp should change.

5. **Unit lane.** `tests/unit/OpenRouterImageAdapter.test.ts` pins the request
   shape per model family and the catalog/`supportedModels` agreement;
   `tests/unit/ImageGenerationService.test.ts` pins one provider call per
   generation. Add a validation case whenever step 6 exposes a listing error.

6. **Live call — mandatory, and the listing is not a substitute.** Route the
   real adapter through `fetch` with a throwaway Jest file (the obsidian mock's
   `__setRequestUrlMock` is the seam; see the harness in
   `tests/unit/helpers/llmAdapterTestHarness.ts`), generate one image per new
   model, read `metadata.reportedCostUsd`, and delete the file. Provider
   listings have been wrong in both directions — a resolution advertised and
   then rejected with a pixel-count minimum, and a preview id still listed
   whose `/endpoints` array is empty. A 200 from `/endpoints` with no endpoints
   is a dead id. Use a mundane object prompt for smoke tests: some vendors'
   moderation flags abstract prompts ("a red circle on white") as violence, and
   the resulting 400 looks like a broken model.

## Guidelines
- Pattern: take the output format from the response's `media_type`, not from
  what was requested — Gemini returns JPEG regardless.
- Pattern: read the wire enum, not the UI enum. Google's `imageConfig.imageSize`
  takes `"512"`; it accepts `"512px"` without an error and then renders and
  bills a 1K image. Compare `usageMetadata.candidatesTokensDetails` image
  tokens across two spellings when a value looks ambiguous — a real 512 image
  is a visibly smaller token count.
- Pattern: never let a token-priced provider pick size and quality for you.
  OpenAI's Images API with no `size`/`quality` resolved to 1536x1024 at `high`
  for gpt-image-1-mini — $0.05 against an $0.011 list price. Send an explicit
  size. gpt-image-2 arbitrary sizes must have both dimensions divisible by 16
  (`1820x1024` is a hard 400; `1792x1008` is an exact 16:9).
- Pattern: prices in the catalog are list prices at the default resolution; the
  actual charge is in the response and is what to report.
- Anti-pattern: adding a model because it appears in `/api/v1/models`. That is
  the chat catalog; use `/api/v1/images/models` for image models.
- Anti-pattern: leaving the `-preview` twin of a GA id as the only entry.
  Providers retire previews without notice and the default breaks silently.

## Next
`verify-model.md` step 4 does not cover image adapters; the live call in step 6
here is its equivalent. Then `self-refine.md`.
