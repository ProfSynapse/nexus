/**
 * Speech/TTS model declarations and default resolution for read-aloud flows.
 *
 * This is intentionally separate from transcription and realtime voice. A
 * provider may support only one of those capabilities.
 */

import type {
  DefaultSpeechModelSettings,
  LLMProviderSettings,
  VoiceDefaultSelectionSource
} from '../../../types/llm/ProviderTypes';

export type SpeechProvider = 'elevenlabs' | 'openai' | 'google' | 'openrouter';

export type SpeechResponseFormat = 'mp3' | 'wav' | 'pcm';

export type SpeechExecution = 'speech-api' | 'speech-websocket';

export interface SpeechVoiceDeclaration {
  id: string;
  name: string;
  description?: string;
}

export interface SpeechModelDeclaration {
  provider: SpeechProvider;
  id: string;
  name: string;
  execution: SpeechExecution;
  defaultVoice?: string;
  voices?: SpeechVoiceDeclaration[];
  supportsDynamicVoices?: boolean;
  supportsStreaming: boolean;
  supportsInstructions: boolean;
  supportsSpeed: boolean;
  responseFormats: SpeechResponseFormat[];
  maxInputTokens?: number;
  maxInputChars?: number;
}

export interface SpeechProviderAvailability {
  provider: SpeechProvider;
  enabled: boolean;
  configured: boolean;
  models?: SpeechModelDeclaration[];
  error?: string;
}

export type VoiceDefaultStatus = 'resolved' | 'invalid' | 'unavailable';

export interface ResolvedSpeechSelection {
  provider?: SpeechProvider;
  model?: string;
  voice?: string;
  source: VoiceDefaultSelectionSource;
  status: VoiceDefaultStatus;
  reason?: string;
}

export interface AppVoiceCapabilityState {
  enabled: boolean;
  configured: boolean;
  error?: string;
}

export type SpeechAppCapabilityStates = Partial<Record<SpeechProvider, AppVoiceCapabilityState>>;

const OPENAI_VOICES: SpeechVoiceDeclaration[] = [
  { id: 'alloy', name: 'Alloy' },
  { id: 'ash', name: 'Ash' },
  { id: 'ballad', name: 'Ballad' },
  { id: 'coral', name: 'Coral' },
  { id: 'echo', name: 'Echo' },
  { id: 'fable', name: 'Fable' },
  { id: 'nova', name: 'Nova' },
  { id: 'onyx', name: 'Onyx' },
  { id: 'sage', name: 'Sage' },
  { id: 'shimmer', name: 'Shimmer' },
  { id: 'verse', name: 'Verse' },
  { id: 'marin', name: 'Marin' },
  { id: 'cedar', name: 'Cedar' }
];

const GEMINI_TTS_VOICES: SpeechVoiceDeclaration[] = [
  { id: 'Zephyr', name: 'Zephyr', description: 'Bright' },
  { id: 'Puck', name: 'Puck', description: 'Upbeat' },
  { id: 'Charon', name: 'Charon', description: 'Informative' },
  { id: 'Kore', name: 'Kore', description: 'Firm' },
  { id: 'Fenrir', name: 'Fenrir', description: 'Excitable' },
  { id: 'Leda', name: 'Leda', description: 'Youthful' },
  { id: 'Aoede', name: 'Aoede', description: 'Breezy' },
  { id: 'Callirrhoe', name: 'Callirrhoe', description: 'Easy-going' },
  { id: 'Iapetus', name: 'Iapetus', description: 'Clear' },
  { id: 'Algieba', name: 'Algieba', description: 'Smooth' },
  { id: 'Achird', name: 'Achird', description: 'Friendly' },
  { id: 'Sulafat', name: 'Sulafat', description: 'Warm' }
];

const SPEECH_MODELS: SpeechModelDeclaration[] = [
  {
    provider: 'elevenlabs',
    id: 'eleven_multilingual_v2',
    name: 'Eleven Multilingual v2',
    execution: 'speech-api',
    defaultVoice: 'EXAVITQu4vr4xnSDxMaL',
    supportsDynamicVoices: true,
    supportsStreaming: true,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['mp3']
  },
  {
    provider: 'elevenlabs',
    id: 'eleven_turbo_v2_5',
    name: 'Eleven Turbo v2.5',
    execution: 'speech-api',
    defaultVoice: 'EXAVITQu4vr4xnSDxMaL',
    supportsDynamicVoices: true,
    supportsStreaming: true,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['mp3']
  },
  {
    provider: 'openai',
    id: 'gpt-4o-mini-tts',
    name: 'GPT-4o mini TTS',
    execution: 'speech-api',
    defaultVoice: 'marin',
    voices: OPENAI_VOICES,
    supportsStreaming: false,
    supportsInstructions: true,
    supportsSpeed: true,
    responseFormats: ['mp3', 'wav', 'pcm'],
    maxInputTokens: 2000
  },
  {
    provider: 'openai',
    id: 'tts-1',
    name: 'TTS 1',
    execution: 'speech-api',
    defaultVoice: 'alloy',
    voices: OPENAI_VOICES,
    supportsStreaming: false,
    supportsInstructions: false,
    supportsSpeed: true,
    responseFormats: ['mp3', 'wav', 'pcm']
  },
  {
    provider: 'openai',
    id: 'tts-1-hd',
    name: 'TTS 1 HD',
    execution: 'speech-api',
    defaultVoice: 'alloy',
    voices: OPENAI_VOICES,
    supportsStreaming: false,
    supportsInstructions: false,
    supportsSpeed: true,
    responseFormats: ['mp3', 'wav', 'pcm']
  },
  {
    provider: 'google',
    id: 'gemini-2.5-flash-preview-tts',
    name: 'Gemini 2.5 Flash Preview TTS',
    execution: 'speech-api',
    defaultVoice: 'Kore',
    voices: GEMINI_TTS_VOICES,
    supportsStreaming: false,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['wav', 'pcm'],
    maxInputTokens: 32000
  },
  {
    provider: 'google',
    id: 'gemini-2.5-pro-preview-tts',
    name: 'Gemini 2.5 Pro Preview TTS',
    execution: 'speech-api',
    defaultVoice: 'Kore',
    voices: GEMINI_TTS_VOICES,
    supportsStreaming: false,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['wav', 'pcm'],
    maxInputTokens: 32000
  },
  {
    provider: 'openrouter',
    id: 'elevenlabs/eleven-turbo-v2',
    name: 'Eleven Turbo v2 via OpenRouter',
    execution: 'speech-api',
    defaultVoice: 'alloy',
    supportsDynamicVoices: true,
    supportsStreaming: false,
    supportsInstructions: false,
    supportsSpeed: true,
    responseFormats: ['mp3', 'pcm']
  }
];

export const SPEECH_PROVIDER_PRIORITY: SpeechProvider[] = [
  'elevenlabs',
  'openai',
  'google',
  'openrouter'
];

export function getSpeechProviders(): SpeechProvider[] {
  return Array.from(new Set(SPEECH_MODELS.map(model => model.provider)));
}

export function getSpeechModelsForProvider(provider: string): SpeechModelDeclaration[] {
  return SPEECH_MODELS.filter(model => model.provider === provider);
}

export function getSpeechModel(
  provider: string | undefined,
  modelId: string | undefined
): SpeechModelDeclaration | undefined {
  if (!provider || !modelId) {
    return undefined;
  }
  return SPEECH_MODELS.find(model => model.provider === provider && model.id === modelId);
}

export function buildSpeechProviderAvailability(
  settings: LLMProviderSettings | null,
  appStates: SpeechAppCapabilityStates = {}
): SpeechProviderAvailability[] {
  return getSpeechProviders().map(provider => {
    const models = getEnabledSpeechModelsForProvider(settings, provider);
    if (provider === 'elevenlabs') {
      const appState = appStates.elevenlabs;
      return {
        provider,
        enabled: appState?.enabled === true,
        configured: appState?.configured === true,
        models,
        error: appState?.error
      };
    }

    const providerConfig = settings?.providers?.[provider];
    return {
      provider,
      enabled: providerConfig?.enabled === true,
      configured: !!providerConfig?.apiKey?.trim(),
      models
    };
  });
}

export function resolveDefaultSpeechSelection(
  settings: LLMProviderSettings | null,
  availability: SpeechProviderAvailability[] = buildSpeechProviderAvailability(settings)
): ResolvedSpeechSelection {
  const configuredDefault = settings?.defaultSpeechModel;
  const source = getSelectionSource(configuredDefault);

  if (source === 'user') {
    return resolveUserSpeechSelection(configuredDefault, availability);
  }

  return resolveAutoSpeechSelection(availability);
}

function resolveUserSpeechSelection(
  configuredDefault: DefaultSpeechModelSettings | undefined,
  availability: SpeechProviderAvailability[]
): ResolvedSpeechSelection {
  const provider = configuredDefault?.provider as SpeechProvider | undefined;
  const model = configuredDefault?.model;
  const voice = configuredDefault?.voice;

  if (!provider || !model) {
    return {
      source: 'user',
      status: 'invalid',
      reason: 'No speech provider/model selected.'
    };
  }

  const providerAvailability = availability.find(item => item.provider === provider);
  if (!providerAvailability?.enabled || !providerAvailability.configured) {
    return {
      provider,
      model,
      voice,
      source: 'user',
      status: 'invalid',
      reason: `Speech provider "${provider}" is not enabled and configured.`
    };
  }

  if (!providerAvailability.models?.some(candidate => candidate.id === model)) {
    return {
      provider,
      model,
      voice,
      source: 'user',
      status: 'invalid',
      reason: `Speech model "${model}" is not available for provider "${provider}".`
    };
  }

  return {
    provider,
    model,
    voice: voice || getSpeechModel(provider, model)?.defaultVoice,
    source: 'user',
    status: 'resolved'
  };
}

function resolveAutoSpeechSelection(
  availability: SpeechProviderAvailability[]
): ResolvedSpeechSelection {
  for (const provider of SPEECH_PROVIDER_PRIORITY) {
    const providerAvailability = availability.find(item => item.provider === provider);
    const firstModel = providerAvailability?.models?.[0];
    if (!providerAvailability?.enabled || !providerAvailability.configured || !firstModel) {
      continue;
    }

    return {
      provider,
      model: firstModel.id,
      voice: firstModel.defaultVoice,
      source: 'auto',
      status: 'resolved'
    };
  }

  return {
    source: 'auto',
    status: 'unavailable',
    reason: 'No configured speech provider is available.'
  };
}

function getEnabledSpeechModelsForProvider(
  settings: LLMProviderSettings | null,
  provider: SpeechProvider
): SpeechModelDeclaration[] {
  const modelConfig = settings?.providers?.[provider]?.models;
  return getSpeechModelsForProvider(provider).filter(model => modelConfig?.[model.id]?.enabled !== false);
}

function getSelectionSource(
  configuredDefault: DefaultSpeechModelSettings | undefined
): VoiceDefaultSelectionSource {
  if (configuredDefault?.source === 'auto') {
    return 'auto';
  }

  if (configuredDefault?.source === 'user') {
    return 'user';
  }

  return configuredDefault?.provider || configuredDefault?.model ? 'user' : 'auto';
}
