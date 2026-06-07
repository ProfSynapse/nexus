import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';

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

const VIDEO_MODELS: VideoModelDeclaration[] = [
  {
    provider: 'google',
    id: 'veo-3.1-generate-preview',
    name: 'Veo 3.1',
    execution: 'long-running-operation',
    supportsReferenceImage: true,
    supportsAudioPrompting: true,
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p', '4k'],
    durations: [4, 6, 8],
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
    aspectRatios: ['16:9', '9:16', '1:1'],
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
    resolutions: ['720p', '1080p'],
    durations: [4, 6, 8],
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
