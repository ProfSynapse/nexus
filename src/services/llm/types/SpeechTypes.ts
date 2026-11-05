/**
 * Speech/TTS model declarations and default resolution for read-aloud flows.
 *
 * This is intentionally separate from transcription and realtime voice. A
 * provider may support only one of those capabilities.
 */

import type { AppsSettings } from '../../../types/apps/AppTypes';
import { getRetiredSpeechModel } from './RetiredMediaModels';
import type {
  DefaultSpeechModelSettings,
  LLMProviderSettings,
  VoiceDefaultSelectionSource
} from '../../../types/llm/ProviderTypes';

export type SpeechProvider = 'elevenlabs' | 'openai' | 'google' | 'mistral' | 'openrouter';

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
  /** Still works, so saved settings keep running, but agents are not offered it. */
  deprecated?: boolean;
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

// tts-1 and tts-1-hd reject ballad, verse, marin and cedar with a 400 (live, 2026-11-05).
const OPENAI_TTS1_VOICES: SpeechVoiceDeclaration[] = OPENAI_VOICES.filter(
  voice => !['ballad', 'verse', 'marin', 'cedar'].includes(voice.id)
);

const GOOGLE_TTS_VOICES: SpeechVoiceDeclaration[] = [
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

// tts-1 style voices do not exist across these models, so each row names a voice from
// its own supported_voices (Fish Audio and Seed Audio take none). Sent one request per
// model on 2026-11-05. Rows with no mp3 answered only in PCM, wrapped as WAV.
// First on purpose: a setup with no chosen model needs a voice known to fit.
const OPENROUTER_ELEVENLABS_VOICES: SpeechVoiceDeclaration[] = [
  'george', 'sarah', 'adam', 'alice', 'bella', 'bill', 'brian', 'callum', 'charlie', 'chris', 'daniel',
  'eric', 'harry', 'jessica', 'laura', 'liam', 'lily', 'matilda', 'river', 'roger', 'will'
].map(id => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));

const OPENROUTER_SPEECH_ROWS: ReadonlyArray<readonly [id: string, name: string, defaultVoice: string | undefined]> = [
  ['deepgram/aura-2', 'Aura-2 via OpenRouter', 'aura-2-thalia-en'],
  ['assemblyai/assemblyai-tts-1', 'TTS 1 via OpenRouter', 'aai-antonioluis'],
  ['bytedance-seed/seed-audio-1-0', 'Seed Audio 1.0 via OpenRouter', undefined],
  ['canopylabs/orpheus-3b-0.1-ft', 'Orpheus 3B via OpenRouter', 'tara'],
  ['deepgram/flux-tts', 'Flux TTS via OpenRouter', 'flux-alexis-en'],
  ['elevenlabs/eleven-flash-v2.5', 'Eleven Flash v2.5 via OpenRouter', 'sarah'],
  ['elevenlabs/eleven-multilingual-v2', 'Eleven Multilingual v2 via OpenRouter', 'sarah'],
  ['elevenlabs/eleven-v3', 'Eleven v3 via OpenRouter', 'sarah'],
  ['elevenlabs/eleven-v3-conversational', 'Eleven v3 Conversational via OpenRouter', 'sarah'],
  ['elevenlabs/eleven-v4', 'Eleven v4 via OpenRouter', 'sarah'],
  ['elevenlabs/eleven-v4-turbo', 'Eleven v4 Turbo via OpenRouter', 'sarah'],
  ['fish-audio/drama-3', 'Drama 3 via OpenRouter', undefined],
  ['fish-audio/s1', 'S1 via OpenRouter', undefined],
  ['fish-audio/s2-pro', 'S2 Pro via OpenRouter', undefined],
  ['fish-audio/s2.1-pro', 'S2.1 Pro via OpenRouter', undefined],
  ['fish-audio/s2.1-pro-free:free', 'S2.1 Pro Free (free) via OpenRouter', undefined],
  ['google/gemini-3.8-flash-lite-tts', 'Gemini 3.8 Flash Lite TTS via OpenRouter', 'Kore'],
  ['google/gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS via OpenRouter', 'Kore'],
  ['hexgrad/kokoro-82m', 'Kokoro 82M via OpenRouter', 'af_alloy'],
  ['heygen/heygen-voice-1', 'HeyGen Voice via OpenRouter', 'nadine'],
  ['heygen/heygen-voice-1-turbo', 'HeyGen Voice Turbo via OpenRouter', 'nadine'],
  ['microsoft/mai-voice-2.1', 'MAI-Voice-2.1 via OpenRouter', 'en-US-Harper:MAI-Voice-2.1'],
  ['microsoft/mai-voice-2.1-flash', 'MAI-Voice-2.1-Flash via OpenRouter', 'en-US-Harper:MAI-Voice-2.1-Flash'],
  ['minimax/speech-2.8-hd', 'Speech 2.8 HD via OpenRouter', 'English_expressive_narrator'],
  ['minimax/speech-2.8-turbo', 'Speech 2.8 Turbo via OpenRouter', 'English_expressive_narrator'],
  ['mistralai/voxtral-mini-tts-2603', 'Voxtral Mini TTS via OpenRouter', 'en_paul_neutral'],
  ['mistralai/voxtral-mini-tts-3-0', 'Voxtral TTS 3 via OpenRouter', 'voice_3150'],
  ['qwen/qwen-audio-3.0-tts-flash', 'Qwen-Audio-3.0-TTS Flash via OpenRouter', 'loongjohn'],
  ['qwen/qwen-audio-3.0-tts-plus', 'Qwen-Audio-3.0-TTS Plus via OpenRouter', 'longanlingxin'],
  ['sesame/csm-1b', 'CSM 1B via OpenRouter', 'conversational_a'],
  ['x-ai/grok-voice-tts-1.0', 'Grok Voice TTS 1.0 via OpenRouter', 'eve'],
];

/** Models whose PCM is the only reliable output. Voxtral 3.0 also answers MP3, sometimes with a near-empty file. */
function isOpenRouterPcmOnly(id: string): boolean {
  return id.startsWith('google/') || id.startsWith('heygen/') || id === 'mistralai/voxtral-mini-tts-3-0';
}

function toOpenRouterSpeechModel([id, name, defaultVoice]: readonly [string, string, string | undefined]): SpeechModelDeclaration {
  const voices = id.startsWith('elevenlabs/') ? OPENROUTER_ELEVENLABS_VOICES
    : id.startsWith('google/') ? GOOGLE_TTS_VOICES
      : undefined;
  return {
    provider: 'openrouter',
    id,
    name,
    execution: 'speech-api',
    defaultVoice,
    ...(voices ? { voices } : { supportsDynamicVoices: true }),
    supportsStreaming: false,
    supportsInstructions: false,
    supportsSpeed: false,
    responseFormats: isOpenRouterPcmOnly(id) ? ['pcm'] : ['mp3', 'pcm'],
  };
}

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
  // https://elevenlabs.io/docs/overview/models. Multilingual v2 stays first so a
  // setup with no chosen model keeps the same voice engine.
  {
    provider: 'elevenlabs',
    id: 'eleven_v4',
    name: 'Eleven v4',
    execution: 'speech-api',
    defaultVoice: 'EXAVITQu4vr4xnSDxMaL',
    supportsDynamicVoices: true,
    supportsStreaming: true,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['mp3'],
    maxInputChars: 10000
  },
  {
    provider: 'elevenlabs',
    id: 'eleven_v4_turbo',
    name: 'Eleven v4 Turbo',
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
    id: 'eleven_v3',
    name: 'Eleven v3',
    execution: 'speech-api',
    defaultVoice: 'EXAVITQu4vr4xnSDxMaL',
    supportsDynamicVoices: true,
    supportsStreaming: true,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['mp3'],
    maxInputChars: 5000
  },
  {
    provider: 'elevenlabs',
    id: 'eleven_v3_conversational',
    name: 'Eleven v3 Conversational',
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
    id: 'eleven_flash_v2_5',
    name: 'Eleven Flash v2.5',
    execution: 'speech-api',
    defaultVoice: 'EXAVITQu4vr4xnSDxMaL',
    supportsDynamicVoices: true,
    supportsStreaming: true,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['mp3'],
    maxInputChars: 40000
  },
  {
    provider: 'elevenlabs',
    id: 'eleven_turbo_v2_5',
    name: 'Eleven Turbo v2.5 (deprecated)',
    execution: 'speech-api',
    defaultVoice: 'EXAVITQu4vr4xnSDxMaL',
    supportsDynamicVoices: true,
    supportsStreaming: true,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['mp3'],
    deprecated: true
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
    voices: OPENAI_TTS1_VOICES,
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
    voices: OPENAI_TTS1_VOICES,
    supportsStreaming: false,
    supportsInstructions: false,
    supportsSpeed: true,
    responseFormats: ['mp3', 'wav', 'pcm']
  },
  // Google's named successors for the TTS previews that shut down 2026-11-17.
  {
    provider: 'google',
    id: 'gemini-3.8-flash-tts',
    name: 'Gemini 3.8 Flash TTS',
    execution: 'speech-api',
    defaultVoice: 'Kore',
    voices: GOOGLE_TTS_VOICES,
    supportsStreaming: false,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['wav', 'pcm'],
    maxInputTokens: 8192
  },
  {
    provider: 'google',
    id: 'gemini-3.8-flash-lite-tts',
    name: 'Gemini 3.8 Flash-Lite TTS',
    execution: 'speech-api',
    defaultVoice: 'Kore',
    voices: GOOGLE_TTS_VOICES,
    supportsStreaming: false,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['wav', 'pcm'],
    maxInputTokens: 8192
  },
  {
    provider: 'mistral',
    id: 'voxtral-mini-tts-2603',
    name: 'Voxtral Mini TTS',
    execution: 'speech-api',
    supportsDynamicVoices: true,
    supportsStreaming: true,
    supportsInstructions: true,
    supportsSpeed: false,
    responseFormats: ['mp3', 'wav', 'pcm']
  },
  ...OPENROUTER_SPEECH_ROWS.map(toOpenRouterSpeechModel),
];

export const SPEECH_PROVIDER_PRIORITY: SpeechProvider[] = [
  'elevenlabs',
  'openai',
  'google',
  'mistral',
  'openrouter'
];

/**
 * The file type each provider's adapter returns. An output path has to match it,
 * and checking before synthesis means a wrong path is not paid for.
 */
export const SPEECH_OUTPUT_EXTENSION: Readonly<Record<SpeechProvider, 'mp3' | 'wav'>> = {
  elevenlabs: 'mp3',
  openai: 'mp3',
  google: 'wav',
  mistral: 'mp3',
  openrouter: 'mp3'
};

/** The file type a model produces. PCM-only models are wrapped as WAV. */
export function getSpeechOutputExtension(provider: SpeechProvider, model: string | undefined): 'mp3' | 'wav' {
  const declaration = getSpeechModel(provider, model);
  return declaration && !declaration.responseFormats.includes('mp3') ? 'wav' : SPEECH_OUTPUT_EXTENSION[provider];
}

/** ElevenLabs is an app, so its key lives in the Apps settings. */
export function getSpeechAppCapabilityStates(appsSettings: AppsSettings | null | undefined): SpeechAppCapabilityStates {
  const elevenLabs = appsSettings?.apps?.elevenlabs;
  return elevenLabs
    ? { elevenlabs: { enabled: elevenLabs.enabled, configured: !!elevenLabs.credentials?.apiKey?.trim() } }
    : {};
}

/** Providers a request can use right now: a key is set and the provider is on. */
export function listConfiguredSpeechProviders(
  settings: LLMProviderSettings | null | undefined,
  appsSettings?: AppsSettings | null
): SpeechProviderAvailability[] {
  return buildSpeechProviderAvailability(settings ?? null, getSpeechAppCapabilityStates(appsSettings))
    .filter(provider => provider.enabled && provider.configured);
}

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
  const model = getRetiredSpeechModel(provider, configuredDefault?.model)?.replacement ?? configuredDefault?.model;
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

  if (provider !== 'openrouter' && !providerAvailability.models?.some(candidate => candidate.id === model)) {
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
