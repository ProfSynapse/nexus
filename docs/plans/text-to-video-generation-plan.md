# Text-To-Video Generation Plan

## Goal

Add a PromptManager `generateVideo` tool and default video generation settings, following the same product shape as `generateAudio`: a small tool, a service that resolves defaults, provider adapters, and binary output saved directly to the vault.

## Research Summary

Primary provider recommendation: support Google direct and OpenRouter.

Why:
- Google documents direct text-to-video generation through `models.generateVideos` / REST `predictLongRunning`.
- The API is explicitly asynchronous and returns a long-running operation that must be polled before downloading the MP4.
- Veo 3.1 supports text-to-video, image-to-video, audio prompting, aspect ratio, and resolution controls.
- It aligns with the current image generation stack, which already supports Google image models and vault reference images.
- OpenRouter now exposes a dedicated asynchronous video generation API (`POST /api/v1/videos`) and a video model discovery endpoint (`GET /api/v1/videos/models`).
- OpenRouter normalizes model differences across resolution, duration, aspect ratio, audio generation, frame images, and reference images, which matches the dynamic provider/model pattern already used for image generation.
- Keeping the first pass to Google + OpenRouter mirrors the existing image-generation product surface and avoids adding another credentials system.

Do not use OpenAI Sora as the primary provider.

Why:
- OpenAI's Videos API exists, but the current official docs state that Sora 2 video generation models and the Videos API are deprecated and will shut down on September 24, 2026.
- If added, it should be behind an explicit deprecated/experimental adapter flag and not be the default path.

Sources:
- OpenAI Videos API: https://developers.openai.com/api/docs/guides/video-generation
- Google Veo in Gemini API: https://ai.google.dev/gemini-api/docs/video
- OpenRouter video generation docs: https://openrouter.ai/docs/guides/overview/multimodal/video-generation
- OpenRouter video models endpoint: https://openrouter.ai/docs/api/api-reference/video-generation/list-videos-models/

## Existing Repo Pattern

Use these as the implementation template:

- `src/agents/promptManager/tools/generateAudio.ts`
- `src/services/audio/AudioGenerationService.ts`
- `src/agents/promptManager/tools/generateImage.ts`
- `src/services/llm/ImageGenerationService.ts`
- `src/services/llm/types/SpeechTypes.ts`
- `src/settings/tabs/DefaultsTab.ts`

The important patterns:
- Tool handles schema, status label, and error wrapping only.
- Service validates path, resolves defaults, calls provider adapter, writes binary output with `vault.createBinary()`.
- Defaults live in `LLMProviderSettings`, not in the tool.
- Tool registration is conditional on configured providers.
- Obsidian API rules apply: use `requestUrl()`, `normalizePath()`, `vault.createBinary()`, no inline styles, no dynamic `innerHTML`.

## Proposed API

Tool slug: `generateVideo`

Parameters:

```ts
export interface GenerateVideoParams extends CommonParameters {
  prompt: string;
  provider?: 'google' | 'openrouter';
  model?: string;
  outputPath: string;
  overwrite?: boolean;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  resolution?: '720p' | '1080p' | '4k';
  seconds?: number;
  referenceImage?: string;
  generateAudio?: boolean;
  negativePrompt?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}
```

Initial v1 should support:
- `prompt`
- `provider`
- `model`
- `outputPath`
- `overwrite`
- `aspectRatio`
- `resolution`
- `referenceImage`

Defer:
- video extension
- video edit/remix
- character assets
- batch queue
- thumbnail/spritesheet download
- webhooks

Result:

```ts
export interface GenerateVideoResult {
  path: string;
  provider: VideoProvider;
  model: string;
  mimeType: 'video/mp4';
  promptLength: number;
  videoSize: number;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  providerJobId?: string;
}
```

## Types And Model Registry

Add `src/services/llm/types/VideoTypes.ts`.

Suggested declarations:

```ts
export type VideoProvider = 'google' | 'openrouter';
export type VideoExecution = 'long-running-operation';
export type VideoAspectRatio = '16:9' | '9:16' | '1:1';
export type VideoResolution = '720p' | '1080p' | '4k';

export interface VideoModelDeclaration {
  provider: VideoProvider;
  id: string;
  name: string;
  execution: VideoExecution;
  supportsReferenceImage: boolean;
  supportsAudioPrompting: boolean;
  aspectRatios: VideoAspectRatio[];
  resolutions: VideoResolution[];
  defaultAspectRatio: VideoAspectRatio;
  defaultResolution: VideoResolution;
  maxSeconds?: number;
}
```

Initial models:

```ts
[
  {
    provider: 'google',
    id: 'veo-3.1-generate-preview',
    name: 'Veo 3.1',
    execution: 'long-running-operation',
    supportsReferenceImage: true,
    supportsAudioPrompting: true,
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p', '4k'],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p'
  },
  {
    provider: 'openrouter',
    id: 'google/veo-3.1-fast',
    name: 'Google: Veo 3.1 Fast via OpenRouter',
    execution: 'long-running-operation',
    supportsReferenceImage: true,
    supportsAudioPrompting: true,
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p'],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p'
  }
]
```

OpenRouter models should be discovered dynamically from `/api/v1/videos/models` where practical, with a small static fallback for offline schema generation and tests.

## Settings

Extend `src/types/llm/ProviderTypes.ts`:

```ts
export interface DefaultVideoModelSettings {
  provider: 'google' | 'openrouter';
  model: string;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
}

export interface LLMProviderSettings {
  defaultVideoModel?: DefaultVideoModelSettings;
}
```

Default:

```ts
defaultVideoModel: {
  provider: 'google',
  model: 'veo-3.1-generate-preview',
  aspectRatio: '16:9',
  resolution: '720p'
}
```

Settings UI:
- Add a "Video generation" group to `DefaultsTab`, near image and voice defaults.
- Provider dropdown: configured video-capable providers only.
- Model dropdown: provider-scoped video models.
- Aspect ratio dropdown: model-supported ratios.
- Resolution dropdown: model-supported resolutions.
- Show a warning if the selected provider is disabled or lacks an API key.

No mockup is required for this small settings addition unless we redesign the whole defaults tab.

## Service And Adapters

Add:
- `src/services/video/VideoGenerationService.ts`
- `src/services/video/VideoGenerationTypes.ts`
- `src/services/video/adapters/GoogleVideoAdapter.ts`
- `src/services/video/adapters/OpenRouterVideoAdapter.ts`

Service responsibilities:
- Resolve provider/model/defaults.
- Validate prompt.
- Validate and normalize `outputPath`.
- Validate reference image path with vault APIs.
- Check existing file and `overwrite`.
- Call adapter.
- Save MP4 with `vault.createBinary()`.
- Return lean metadata.

Adapter interface:

```ts
export interface VideoGenerationAdapter {
  readonly provider: VideoProvider;
  isAvailable(): boolean;
  generate(request: ResolvedVideoGenerationRequest): Promise<VideoGenerationAdapterResult>;
}
```

Google adapter flow:
- Start operation with `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning`.
- Poll `GET https://generativelanguage.googleapis.com/v1beta/{operationName}` every 10 seconds by default.
- Extract video URI from the completed response.
- Download the MP4 with the same API key header.
- Return `ArrayBuffer` and metadata.

OpenRouter adapter flow:
- Fetch/cached model metadata from `GET https://openrouter.ai/api/v1/videos/models`.
- Submit generation with `POST https://openrouter.ai/api/v1/videos`.
- Poll `GET https://openrouter.ai/api/v1/videos/{jobId}` or the returned `polling_url`.
- When complete, download MP4 from `GET https://openrouter.ai/api/v1/videos/{jobId}/content` or an unsigned URL returned by the job status.
- Return `ArrayBuffer`, model metadata, and provider job ID.

Implementation note:
- Use `requestUrl()`, not `fetch()`.
- Use JSON REST first. Do not add `@google/genai` unless we hit a REST limitation.
- Avoid Node-only modules so mobile compatibility is not worsened.

## PromptManager Integration

Add:
- `src/agents/promptManager/tools/generateVideo.ts`
- export from `src/agents/promptManager/tools/index.ts`
- register in `PromptManagerAgent`

Registration:
- `shouldHaveGenerateVideo(settings)` returns true when Google or OpenRouter is enabled and configured.
- On settings change, mirror the existing image/audio unregister/register refresh logic.

Tool status label:
- Running: `Generating video`
- Success: `Generated video`
- Failure: `Failed to generate video`

Trace display:
- Add `generateVideo` to `src/services/trace/TraceContentFormatter.ts`.

Docs/schema:
- Regenerate tool schemas after implementation.
- Update `docs/TOOL_REFERENCE.md` if that file is maintained manually.

## File Storage

Default output path should be explicit, like audio:
- Required `outputPath`.
- Usually `video/{slug-or-timestamp}.mp4`.

Rationale:
- Video files are large.
- The caller should choose the destination.
- This follows the artifact guidance already in `AGENTS.md`.

Overwrite behavior:
- Same as `AudioGenerationService`: refuse existing file unless `overwrite: true`.
- For overwrite, write a temporary file first, then trash/rename so failed downloads do not corrupt an existing asset.

## Testing Plan

Unit tests:
- default resolution picks explicit params before settings before first available provider
- unavailable provider errors are actionable
- invalid path rejected
- existing output path rejected without overwrite
- reference image missing rejected
- Google adapter maps start/poll/download success
- Google adapter handles failed operation status
- Google adapter handles timeout
- OpenRouter adapter maps model discovery, submit, poll, and download success
- OpenRouter adapter validates requested resolution/aspect ratio/duration against model metadata when available
- PromptManager registers/unregisters `generateVideo` when Google/OpenRouter config changes

Manual test in Obsidian:
- Configure Google API key.
- Confirm settings show Video generation defaults.
- Use MCP `getTools` and verify `promptManager_generateVideo` appears.
- Generate a short 720p video to `video/test-veo.mp4`.
- Confirm the MP4 exists in the vault and plays in Obsidian/system player.
- Test existing path without `overwrite`.
- Test with a reference image from the vault.
- Configure OpenRouter API key.
- Confirm OpenRouter video models populate in defaults.
- Generate a short video through OpenRouter and confirm the saved MP4.

## Phasing

Phase 1: Google/OpenRouter text-to-video
- Add types, defaults, settings UI, service, Google adapter, OpenRouter adapter, PromptManager tool, trace label, tests.

Phase 2: image-to-video polish
- Support `referenceImage` fully, including MIME detection and base64 upload body.
- Consider image size/resolution validation before sending requests.

Phase 3: model discovery polish
- Cache OpenRouter video model metadata with a short TTL.
- Use provider metadata to drive the tool schema where available.
- Add richer validation/error messages for unsupported resolution, aspect ratio, duration, frame images, and reference images.

Phase 4: advanced video workflows
- Extend existing videos.
- Edit existing videos.
- Download thumbnail/spritesheet artifacts.
- Add queue persistence in `.nexus/` for long-running jobs that outlive an Obsidian session.

## Open Questions

1. Should the first implementation expose only text-to-video, or include `referenceImage` from day one?
2. Should long-running video job state be persisted immediately, or is in-memory polling acceptable for v1?
3. Should video generation be desktop-only if provider downloads prove unreliable on mobile?
4. Should OpenRouter default to `google/veo-3.1-fast`, `google/veo-3.1`, or dynamic "first available by configured defaults"?

## Recommendation

Ship phase 1 with Google direct and OpenRouter, text-to-video plus optional reference image if the payload is straightforward in implementation. Keep OpenAI Sora out as a direct provider because its API is deprecated; if users want it anyway, OpenRouter can expose it through the same normalized video API while it remains available.
