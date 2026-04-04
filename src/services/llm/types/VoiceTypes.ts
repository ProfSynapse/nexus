/**
 * Shared types and model declarations for transcription and audio understanding.
 *
 * This mirrors the role ImageTypes plays for image generation:
 * one shared model/result contract that multiple product surfaces can consume.
 */

import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';

export type TranscriptionProvider = 'openai' | 'groq' | 'google' | 'openrouter' | 'mistral' | 'deepgram' | 'assemblyai';

export type TranscriptionExecution =
  | 'speech-api-segmented'
  | 'speech-api-plain'
  | 'speech-api-async'
  | 'multimodal-audio';

export interface TranscriptionWord {
  text: string;
  startSeconds: number;
  endSeconds: number;
  confidence?: number;
  speaker?: string;
}

export interface TranscriptionSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence?: number;
  speaker?: string;
  words?: TranscriptionWord[];
}

export interface TranscriptionResult {
  provider: TranscriptionProvider;
  model: string;
  text: string;
  durationSeconds?: number;
  segments: TranscriptionSegment[];
  metadata?: Record<string, unknown>;
}

export interface TranscriptionRequest {
  audioData: ArrayBuffer;
  mimeType: string;
  fileName: string;
  provider?: TranscriptionProvider;
  model?: string;
  prompt?: string;
  requestWordTimestamps?: boolean;
  requestSpeakerLabels?: boolean;
}

export interface TranscriptionModelDeclaration {
  provider: TranscriptionProvider;
  id: string;
  name: string;
  execution: TranscriptionExecution;
  supportsWordTimestamps: boolean;
  supportsSpeakerLabels?: boolean;
  supportsPrompt?: boolean;
}

export interface TranscriptionProviderAvailability {
  provider: TranscriptionProvider;
  available: boolean;
  models: TranscriptionModelDeclaration[];
  error?: string;
}

export interface AudioChunk {
  data: ArrayBuffer;
  mimeType: string;
  startSeconds: number;
  durationSeconds: number;
}

const TRANSCRIPTION_MODELS: TranscriptionModelDeclaration[] = [
  {
    provider: 'openai',
    id: 'gpt-4o-transcribe',
    name: 'GPT-4o Transcribe',
    execution: 'speech-api-plain',
    supportsWordTimestamps: false,
    supportsPrompt: true
  },
  {
    provider: 'openai',
    id: 'gpt-4o-mini-transcribe',
    name: 'GPT-4o Mini Transcribe',
    execution: 'speech-api-plain',
    supportsWordTimestamps: false,
    supportsPrompt: true
  },
  {
    provider: 'openai',
    id: 'whisper-1',
    name: 'Whisper 1',
    execution: 'speech-api-segmented',
    supportsWordTimestamps: true,
    supportsPrompt: true
  },
  {
    provider: 'groq',
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    execution: 'speech-api-segmented',
    supportsWordTimestamps: true,
    supportsPrompt: true
  },
  {
    provider: 'groq',
    id: 'whisper-large-v3',
    name: 'Whisper Large v3',
    execution: 'speech-api-segmented',
    supportsWordTimestamps: true,
    supportsPrompt: true
  },
  {
    provider: 'mistral',
    id: 'voxtral-mini-latest',
    name: 'Voxtral Mini Transcribe',
    execution: 'speech-api-segmented',
    supportsWordTimestamps: true,
    supportsSpeakerLabels: true,
    supportsPrompt: true
  },
  {
    provider: 'deepgram',
    id: 'nova-3',
    name: 'Nova-3',
    execution: 'speech-api-segmented',
    supportsWordTimestamps: true,
    supportsSpeakerLabels: true,
    supportsPrompt: false
  },
  {
    provider: 'assemblyai',
    id: 'best',
    name: 'Best',
    execution: 'speech-api-async',
    supportsWordTimestamps: true,
    supportsSpeakerLabels: true,
    supportsPrompt: true
  },
  {
    provider: 'google',
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3.0 Flash Preview (Audio)',
    execution: 'multimodal-audio',
    supportsWordTimestamps: false,
    supportsPrompt: true
  },
  {
    provider: 'google',
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (Audio)',
    execution: 'multimodal-audio',
    supportsWordTimestamps: false,
    supportsPrompt: true
  },
  {
    provider: 'openrouter',
    id: 'google/gemini-3-flash-preview',
    name: 'Gemini 3.0 Flash Preview (Audio)',
    execution: 'multimodal-audio',
    supportsWordTimestamps: false,
    supportsPrompt: true
  },
  {
    provider: 'openrouter',
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (Audio)',
    execution: 'multimodal-audio',
    supportsWordTimestamps: false,
    supportsPrompt: true
  }
];

export function getTranscriptionModelsForProvider(provider: string): TranscriptionModelDeclaration[] {
  return TRANSCRIPTION_MODELS.filter(model => model.provider === provider);
}

export function getTranscriptionModel(
  provider: string,
  modelId: string
): TranscriptionModelDeclaration | undefined {
  return TRANSCRIPTION_MODELS.find(model => model.provider === provider && model.id === modelId);
}

export function getTranscriptionProviders(): TranscriptionProvider[] {
  return Array.from(new Set(TRANSCRIPTION_MODELS.map(model => model.provider)));
}

export function resolveDefaultTranscriptionSelection(
  settings: LLMProviderSettings | null,
  provider?: string,
  model?: string
): { provider?: TranscriptionProvider; model?: string } {
  if (provider && model && getTranscriptionModel(provider, model)) {
    return {
      provider: provider as TranscriptionProvider,
      model
    };
  }

  const settingsProvider = settings?.defaultTranscriptionModel?.provider;
  const settingsModel = settings?.defaultTranscriptionModel?.model;
  if (settingsProvider && settingsModel && getTranscriptionModel(settingsProvider, settingsModel)) {
    return {
      provider: settingsProvider as TranscriptionProvider,
      model: settingsModel
    };
  }

  if (provider) {
    const firstModel = getTranscriptionModelsForProvider(provider)[0];
    if (firstModel) {
      return {
        provider: provider as TranscriptionProvider,
        model: firstModel.id
      };
    }
  }

  for (const availableProvider of getTranscriptionProviders()) {
    const config = settings?.providers?.[availableProvider];
    if (!config?.enabled || !config.apiKey) {
      continue;
    }

    const firstModel = getTranscriptionModelsForProvider(availableProvider)[0];
    if (firstModel) {
      return {
        provider: availableProvider,
        model: firstModel.id
      };
    }
  }

  return {};
}
