/**
 * Music and sound-effect models for generateAudio. One `type` for the caller, with
 * each model declaring how it takes duration and instrumental, because providers
 * differ: ElevenLabs has parameters, Lyria reads them from the prompt, and Lyria
 * Clip is always 30 seconds. Speech models live in SpeechTypes.
 *
 * Sources: https://elevenlabs.io/docs/overview/models,
 * https://ai.google.dev/gemini-api/docs/music-generation, and OpenRouter's
 * /api/v1/models?output_modalities=audio. Sent live on 2026-11-05.
 */

import type { AppsSettings } from '../../../types/apps/AppTypes';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import { listConfiguredSpeechProviders } from './SpeechTypes';

export type AudioType = 'speech' | 'music' | 'sfx';
export type GeneratedAudioType = Exclude<AudioType, 'speech'>;
export type GeneratedAudioProvider = 'elevenlabs' | 'google' | 'openrouter';

export type AudioDurationControl =
  /** The API takes a length in this range. Usually close, not exact. */
  | { control: 'parameter'; minSeconds: number; maxSeconds: number }
  /** Length is only influenced by asking in the prompt, and can be far off. */
  | { control: 'prompt' }
  /** Every generation is this long. */
  | { control: 'fixed'; seconds: number };

export interface GeneratedAudioModelDeclaration {
  type: GeneratedAudioType;
  provider: GeneratedAudioProvider;
  id: string;
  name: string;
  duration: AudioDurationControl;
  /** How to ask for no vocals. Sound effects have none to remove. */
  instrumental?: 'parameter' | 'prompt';
  supportsLoop?: boolean;
}

/** First match for a type wins when a caller names neither provider nor model. */
const GENERATED_AUDIO_MODELS: readonly GeneratedAudioModelDeclaration[] = [
  {
    type: 'music',
    provider: 'elevenlabs',
    id: 'music_v2_5',
    name: 'Eleven Music v2.5',
    duration: { control: 'parameter', minSeconds: 3, maxSeconds: 600 },
    instrumental: 'parameter',
  },
  {
    type: 'music',
    provider: 'google',
    id: 'lyria-3.5',
    name: 'Lyria 3.5',
    duration: { control: 'prompt' },
    instrumental: 'prompt',
  },
  {
    type: 'music',
    provider: 'google',
    id: 'lyria-3-clip-preview',
    name: 'Lyria 3 Clip',
    duration: { control: 'fixed', seconds: 30 },
    instrumental: 'prompt',
  },
  // lyria-3.5 is not on OpenRouter yet, so its Pro predecessor is the full-song option.
  {
    type: 'music',
    provider: 'openrouter',
    id: 'google/lyria-3-pro-preview',
    name: 'Lyria 3 Pro via OpenRouter',
    duration: { control: 'prompt' },
    instrumental: 'prompt',
  },
  {
    type: 'music',
    provider: 'openrouter',
    id: 'google/lyria-3-clip-preview',
    name: 'Lyria 3 Clip via OpenRouter',
    duration: { control: 'fixed', seconds: 30 },
    instrumental: 'prompt',
  },
  {
    type: 'sfx',
    provider: 'elevenlabs',
    id: 'eleven_text_to_sound_v3',
    name: 'Eleven SFX v3',
    duration: { control: 'parameter', minSeconds: 0.5, maxSeconds: 30 },
    supportsLoop: true,
  },
];

export function getGeneratedAudioModel(provider: string | undefined, id: string | undefined): GeneratedAudioModelDeclaration | undefined {
  return GENERATED_AUDIO_MODELS.find(model => model.provider === provider && model.id === id);
}

/** Models a request can use right now: the provider has a key and is switched on. */
export function listConfiguredGeneratedAudioModels(
  llmSettings: LLMProviderSettings | null | undefined,
  appsSettings?: AppsSettings | null,
  type?: GeneratedAudioType
): GeneratedAudioModelDeclaration[] {
  const providers = listConfiguredSpeechProviders(llmSettings, appsSettings).map(item => item.provider as string);
  return GENERATED_AUDIO_MODELS.filter(model => providers.includes(model.provider) && (!type || model.type === type));
}
