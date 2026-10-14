import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';

export type VideoProvider = 'google' | 'openrouter';
export type VideoExecution = 'long-running-operation';
export type VideoAspectRatio = '16:9' | '9:16' | '1:1';
export type VideoResolution = '360p' | '720p' | '1080p' | '4k';

export interface VideoModelDeclaration {
  provider: VideoProvider;
  id: string;
  name: string;
  execution: VideoExecution;
  supportsReferenceImage: boolean;
  supportsAudioPrompting: boolean;
  aspectRatios: VideoAspectRatio[];
  resolutions: VideoResolution[];
  durations?: number[];
  defaultAspectRatio: VideoAspectRatio;
  defaultResolution: VideoResolution;
}

export interface VideoProviderAvailability {
  provider: VideoProvider;
  enabled: boolean;
  configured: boolean;
  models: VideoModelDeclaration[];
}

export interface ResolvedVideoSelection {
  provider?: VideoProvider;
  model?: string;
  modelDeclaration?: VideoModelDeclaration;
  status: 'resolved' | 'unavailable' | 'invalid';
  reason?: string;
}

/**
 * Video model catalog. Google direct facts come from
 * https://ai.google.dev/gemini-api/docs/omni, /docs/models/gemini-omni-flash
 * and /docs/deprecations; OpenRouter facts from
 * https://openrouter.ai/api/v1/videos/models, which the OpenRouter adapter
 * also re-reads at request time to validate a request.
 *
 * Retired ids (the Google Veo 3.1 previews) are not listed here; saved
 * settings and tool calls that still name one are mapped to the successor by
 * RetiredMediaModels.
 */
const VIDEO_MODELS: VideoModelDeclaration[] = [
  {
    // GA 2026-08-27; Google's documented replacement for every Veo 3.1 preview
    // id. Served only by the Interactions API (POST /v1beta/interactions).
    // Always generates audio; no negative-prompt or audio-off parameter. Up to
    // two input images (first frame, optional last frame) or reference images.
    // 1080p and 4k are upscaled from the native render.
    provider: 'google',
    id: 'gemini-omni-1.1-flash',
    name: 'Gemini Omni Flash',
    execution: 'long-running-operation',
    supportsReferenceImage: true,
    supportsAudioPrompting: true,
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['360p', '720p', '1080p', '4k'],
    durations: [3, 4, 5, 6, 7, 8, 9, 10],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p',
  },
  {
    provider: 'openrouter',
    id: 'google/veo-3.1-fast',
    name: 'Google: Veo 3.1 Fast via OpenRouter',
    execution: 'long-running-operation',
    supportsReferenceImage: true,
    supportsAudioPrompting: true,
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4k'],
    durations: [4, 6, 8],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p',
  },
  {
    provider: 'openrouter',
    id: 'google/veo-3.1-lite',
    name: 'Google: Veo 3.1 Lite via OpenRouter',
    execution: 'long-running-operation',
    supportsReferenceImage: true,
    supportsAudioPrompting: true,
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    durations: [4, 6, 8],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p',
  },
  {
    provider: 'openrouter',
    id: 'google/veo-3.1',
    name: 'Google: Veo 3.1 via OpenRouter',
    execution: 'long-running-operation',
    supportsReferenceImage: true,
    supportsAudioPrompting: true,
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4k'],
    durations: [4, 6, 8],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p',
  },
  {
    // Added 2026-10-14 from /api/v1/videos/models. Listing also offers 480p and 4:3/3:4/21:9, outside the internal unions.
    provider: 'openrouter',
    id: 'bytedance/seedance-2.5',
    name: 'ByteDance: Seedance 2.5 via OpenRouter',
    execution: 'long-running-operation',
    supportsReferenceImage: true,
    supportsAudioPrompting: true,
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p'],
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p',
  },
  {
    // Added 2026-10-14 from /api/v1/videos/models. First/last-frame control only; no input_references.
    provider: 'openrouter',
    id: 'kwaivgi/kling-v3.0-pro',
    name: 'Kling: Video v3.0 Pro via OpenRouter',
    execution: 'long-running-operation',
    supportsReferenceImage: false,
    supportsAudioPrompting: true,
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p'],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p',
  },
  {
    // Added 2026-10-14 from /api/v1/videos/models. Starting-frame image only; the listing does not declare generate_audio.
    provider: 'openrouter',
    id: 'x-ai/grok-imagine-video-1.5',
    name: 'xAI: Grok Imagine Video 1.5 via OpenRouter',
    execution: 'long-running-operation',
    supportsReferenceImage: false,
    supportsAudioPrompting: false,
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p'],
    durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p',
  },
  {
    // Added 2026-10-14 from /api/v1/videos/models. First-frame image only; no audio.
    provider: 'openrouter',
    id: 'runway/gen-4.5',
    name: 'Runway: Gen-4.5 via OpenRouter',
    execution: 'long-running-operation',
    supportsReferenceImage: false,
    supportsAudioPrompting: false,
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p'],
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    defaultAspectRatio: '16:9',
    defaultResolution: '720p',
  },
];

export const VIDEO_PROVIDER_PRIORITY: VideoProvider[] = ['google', 'openrouter'];

export function getVideoProviders(): VideoProvider[] {
  return Array.from(new Set(VIDEO_MODELS.map(model => model.provider)));
}

export function getVideoModelsForProvider(provider: string): VideoModelDeclaration[] {
  return VIDEO_MODELS.filter(model => model.provider === provider);
}

export function getVideoModel(
  provider: string | undefined,
  modelId: string | undefined
): VideoModelDeclaration | undefined {
  if (!provider || !modelId) {
    return undefined;
  }
  return VIDEO_MODELS.find(model => model.provider === provider && model.id === modelId);
}

export function buildVideoProviderAvailability(settings: LLMProviderSettings | null): VideoProviderAvailability[] {
  return getVideoProviders().map(provider => {
    const providerConfig = settings?.providers?.[provider];
    const modelConfig = providerConfig?.models;
    return {
      provider,
      enabled: providerConfig?.enabled === true,
      configured: !!providerConfig?.apiKey?.trim(),
      models: getVideoModelsForProvider(provider).filter(model => modelConfig?.[model.id]?.enabled !== false),
    };
  });
}

export function resolveDefaultVideoSelection(
  settings: LLMProviderSettings | null,
  provider?: string,
  model?: string,
  availability: VideoProviderAvailability[] = buildVideoProviderAvailability(settings)
): ResolvedVideoSelection {
  const explicit = resolveSpecificVideoSelection(provider, model, availability);
  if (explicit.status === 'resolved' || provider || model) {
    return explicit;
  }

  const settingsDefault = settings?.defaultVideoModel;
  const configured = resolveSpecificVideoSelection(settingsDefault?.provider, settingsDefault?.model, availability);
  if (configured.status === 'resolved') {
    return configured;
  }

  for (const candidateProvider of VIDEO_PROVIDER_PRIORITY) {
    const providerAvailability = availability.find(item => item.provider === candidateProvider);
    const firstModel = providerAvailability?.models[0];
    if (!providerAvailability?.enabled || !providerAvailability.configured || !firstModel) {
      continue;
    }

    return {
      provider: candidateProvider,
      model: firstModel.id,
      modelDeclaration: firstModel,
      status: 'resolved',
    };
  }

  return {
    status: 'unavailable',
    reason: 'No configured video generation provider is available.',
  };
}

function resolveSpecificVideoSelection(
  provider: string | undefined,
  model: string | undefined,
  availability: VideoProviderAvailability[]
): ResolvedVideoSelection {
  if (!provider && !model) {
    return {
      status: 'unavailable',
      reason: 'No video provider/model selected.',
    };
  }

  if (!provider) {
    return {
      model,
      status: 'invalid',
      reason: 'Video provider is required when a model is specified.',
    };
  }

  if (provider !== 'google' && provider !== 'openrouter') {
    return {
      status: 'invalid',
      reason: `Video provider "${provider}" is not supported.`,
    };
  }

  const providerAvailability = availability.find(item => item.provider === provider);
  if (!providerAvailability?.enabled || !providerAvailability.configured) {
    return {
      provider,
      model,
      status: 'invalid',
      reason: `Video provider "${provider}" is not enabled and configured.`,
    };
  }

  const selectedModel = model
    ? providerAvailability.models.find(candidate => candidate.id === model)
    : providerAvailability.models[0];

  if (!selectedModel) {
    return {
      provider,
      model,
      status: 'invalid',
      reason: model
        ? `Video model "${model}" is not available for provider "${provider}".`
        : `No video model is available for provider "${provider}".`,
    };
  }

  return {
    provider,
    model: selectedModel.id,
    modelDeclaration: selectedModel,
    status: 'resolved',
  };
}
