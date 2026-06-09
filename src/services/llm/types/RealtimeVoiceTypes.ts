/**
 * Realtime voice model declarations and default resolution for live chat.
 *
 * This deliberately excludes transcription-only and TTS-only providers.
 */

import type {
  DefaultRealtimeVoiceModelSettings,
  LLMProviderSettings,
  VoiceDefaultSelectionSource
} from '../../../types/llm/ProviderTypes';

export type RealtimeVoiceProvider = 'openai' | 'google' | 'elevenlabs';

export type RealtimeVoiceTransport = 'webrtc' | 'websocket';

export interface RealtimeVoiceDeclaration {
  id: string;
  name: string;
  description?: string;
}

export interface RealtimeVoiceModelDeclaration {
  provider: RealtimeVoiceProvider;
  id: string;
  name: string;
  transport: RealtimeVoiceTransport;
  defaultVoice?: string;
  voices?: RealtimeVoiceDeclaration[];
  supportsDynamicVoices?: boolean;
  supportsTools: boolean;
  supportsTranscripts: boolean;
  maxSessionMinutes?: number;
  requiresAgent?: boolean;
}

export interface RealtimeVoiceProviderAvailability {
  provider: RealtimeVoiceProvider;
  enabled: boolean;
  configured: boolean;
  models?: RealtimeVoiceModelDeclaration[];
  error?: string;
}

export type RealtimeVoiceDefaultStatus = 'resolved' | 'invalid' | 'unavailable';

export interface ResolvedRealtimeVoiceSelection {
  provider?: RealtimeVoiceProvider;
  model?: string;
  voice?: string;
  source: VoiceDefaultSelectionSource;
  status: RealtimeVoiceDefaultStatus;
  reason?: string;
}

export interface RealtimeAppCapabilityState {
  enabled: boolean;
  configured: boolean;
  error?: string;
}

export type RealtimeAppCapabilityStates = Partial<Record<RealtimeVoiceProvider, RealtimeAppCapabilityState>>;

const OPENAI_REALTIME_VOICES: RealtimeVoiceDeclaration[] = [
  { id: 'alloy', name: 'Alloy' },
  { id: 'ash', name: 'Ash' },
  { id: 'ballad', name: 'Ballad' },
  { id: 'coral', name: 'Coral' },
  { id: 'echo', name: 'Echo' },
  { id: 'sage', name: 'Sage' },
  { id: 'shimmer', name: 'Shimmer' },
  { id: 'verse', name: 'Verse' },
  { id: 'marin', name: 'Marin' },
  { id: 'cedar', name: 'Cedar' }
];

const GOOGLE_REALTIME_VOICES: RealtimeVoiceDeclaration[] = [
  { id: 'Zephyr', name: 'Zephyr', description: 'Bright' },
  { id: 'Puck', name: 'Puck', description: 'Upbeat' },
  { id: 'Charon', name: 'Charon', description: 'Informative' },
  { id: 'Kore', name: 'Kore', description: 'Firm' },
  { id: 'Fenrir', name: 'Fenrir', description: 'Excitable' },
  { id: 'Leda', name: 'Leda', description: 'Youthful' },
  { id: 'Orus', name: 'Orus', description: 'Firm' },
  { id: 'Aoede', name: 'Aoede', description: 'Breezy' },
  { id: 'Callirrhoe', name: 'Callirrhoe', description: 'Easy-going' },
  { id: 'Autonoe', name: 'Autonoe', description: 'Bright' },
  { id: 'Enceladus', name: 'Enceladus', description: 'Breathy' },
  { id: 'Iapetus', name: 'Iapetus', description: 'Clear' },
  { id: 'Umbriel', name: 'Umbriel', description: 'Easy-going' },
  { id: 'Algieba', name: 'Algieba', description: 'Smooth' },
  { id: 'Despina', name: 'Despina', description: 'Smooth' },
  { id: 'Erinome', name: 'Erinome', description: 'Clear' },
  { id: 'Algenib', name: 'Algenib', description: 'Gravelly' },
  { id: 'Rasalgethi', name: 'Rasalgethi', description: 'Informative' },
  { id: 'Laomedeia', name: 'Laomedeia', description: 'Upbeat' },
  { id: 'Achernar', name: 'Achernar', description: 'Soft' },
  { id: 'Alnilam', name: 'Alnilam', description: 'Firm' },
  { id: 'Schedar', name: 'Schedar', description: 'Even' },
  { id: 'Gacrux', name: 'Gacrux', description: 'Mature' },
  { id: 'Pulcherrima', name: 'Pulcherrima', description: 'Forward' },
  { id: 'Achird', name: 'Achird', description: 'Friendly' },
  { id: 'Zubenelgenubi', name: 'Zubenelgenubi', description: 'Casual' },
  { id: 'Vindemiatrix', name: 'Vindemiatrix', description: 'Gentle' },
  { id: 'Sadachbia', name: 'Sadachbia', description: 'Lively' },
  { id: 'Sadaltager', name: 'Sadaltager', description: 'Knowledgeable' },
  { id: 'Sulafat', name: 'Sulafat', description: 'Warm' },
];

const REALTIME_VOICE_MODELS: RealtimeVoiceModelDeclaration[] = [
  {
    provider: 'openai',
    id: 'gpt-realtime-2',
    name: 'GPT Realtime 2',
    transport: 'webrtc',
    defaultVoice: 'marin',
    voices: OPENAI_REALTIME_VOICES,
    supportsTools: true,
    supportsTranscripts: true,
    maxSessionMinutes: 60
  },
  {
    provider: 'openai',
    id: 'gpt-realtime-mini',
    name: 'GPT Realtime mini',
    transport: 'webrtc',
    defaultVoice: 'marin',
    voices: OPENAI_REALTIME_VOICES,
    supportsTools: true,
    supportsTranscripts: true,
    maxSessionMinutes: 60
  },
  {
    provider: 'google',
    id: 'gemini-3.1-flash-live-preview',
    name: 'Gemini 3.1 Flash Live Preview',
    transport: 'websocket',
    defaultVoice: 'Kore',
    voices: GOOGLE_REALTIME_VOICES,
    supportsTools: true,
    supportsTranscripts: true
  },
  {
    provider: 'elevenlabs',
    id: 'eleven-agents-conversation',
    name: 'ElevenAgents conversation',
    transport: 'websocket',
    supportsDynamicVoices: true,
    supportsTools: true,
    supportsTranscripts: true,
    requiresAgent: true
  }
];

export const REALTIME_VOICE_PROVIDER_PRIORITY: RealtimeVoiceProvider[] = [
  'openai',
  'google',
  'elevenlabs'
];

export function getRealtimeVoiceProviders(): RealtimeVoiceProvider[] {
  return Array.from(new Set(REALTIME_VOICE_MODELS.map(model => model.provider)));
}

export function getRealtimeVoiceModelsForProvider(provider: string): RealtimeVoiceModelDeclaration[] {
  return REALTIME_VOICE_MODELS.filter(model => model.provider === provider);
}

export function getRealtimeVoiceModel(
  provider: string | undefined,
  modelId: string | undefined
): RealtimeVoiceModelDeclaration | undefined {
  if (!provider || !modelId) {
    return undefined;
  }
  return REALTIME_VOICE_MODELS.find(model => model.provider === provider && model.id === modelId);
}

export function buildRealtimeVoiceProviderAvailability(
  settings: LLMProviderSettings | null,
  appStates: RealtimeAppCapabilityStates = {}
): RealtimeVoiceProviderAvailability[] {
  return getRealtimeVoiceProviders().map(provider => {
    const models = getEnabledRealtimeModelsForProvider(settings, provider);
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

export function resolveDefaultRealtimeVoiceSelection(
  settings: LLMProviderSettings | null,
  availability: RealtimeVoiceProviderAvailability[] = buildRealtimeVoiceProviderAvailability(settings)
): ResolvedRealtimeVoiceSelection {
  const configuredDefault = settings?.defaultRealtimeVoiceModel;
  const source = getSelectionSource(configuredDefault);

  if (source === 'user') {
    return resolveUserRealtimeSelection(configuredDefault, availability);
  }

  return resolveAutoRealtimeSelection(availability);
}

function resolveUserRealtimeSelection(
  configuredDefault: DefaultRealtimeVoiceModelSettings | undefined,
  availability: RealtimeVoiceProviderAvailability[]
): ResolvedRealtimeVoiceSelection {
  const provider = configuredDefault?.provider as RealtimeVoiceProvider | undefined;
  const model = configuredDefault?.model;
  const voice = configuredDefault?.voice;

  if (!provider || !model) {
    return {
      source: 'user',
      status: 'invalid',
      reason: 'No realtime voice provider/model selected.'
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
      reason: `Realtime voice provider "${provider}" is not enabled and configured.`
    };
  }

  if (!providerAvailability.models?.some(candidate => candidate.id === model)) {
    return {
      provider,
      model,
      voice,
      source: 'user',
      status: 'invalid',
      reason: `Realtime voice model "${model}" is not available for provider "${provider}".`
    };
  }

  return {
    provider,
    model,
    voice: voice || getRealtimeVoiceModel(provider, model)?.defaultVoice,
    source: 'user',
    status: 'resolved'
  };
}

function resolveAutoRealtimeSelection(
  availability: RealtimeVoiceProviderAvailability[]
): ResolvedRealtimeVoiceSelection {
  for (const provider of REALTIME_VOICE_PROVIDER_PRIORITY) {
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
    reason: 'No configured realtime voice provider is available.'
  };
}

function getEnabledRealtimeModelsForProvider(
  settings: LLMProviderSettings | null,
  provider: RealtimeVoiceProvider
): RealtimeVoiceModelDeclaration[] {
  const modelConfig = settings?.providers?.[provider]?.models;
  return getRealtimeVoiceModelsForProvider(provider).filter(model => modelConfig?.[model.id]?.enabled !== false);
}

function getSelectionSource(
  configuredDefault: DefaultRealtimeVoiceModelSettings | undefined
): VoiceDefaultSelectionSource {
  if (configuredDefault?.source === 'auto') {
    return 'auto';
  }

  if (configuredDefault?.source === 'user') {
    return 'user';
  }

  return configuredDefault?.provider || configuredDefault?.model ? 'user' : 'auto';
}
