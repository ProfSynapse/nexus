/**
 * Compatibility shim for the old ingest-local transcription API.
 *
 * New code should use src/services/llm/TranscriptionService.ts directly.
 */

import type { TranscriptionSegment } from '../../types';
import { TranscriptionService as SharedTranscriptionService } from '../../../../services/llm/TranscriptionService';
import { DEFAULT_LLM_PROVIDER_SETTINGS, type LLMProviderSettings } from '../../../../types/llm/ProviderTypes';
import { getTranscriptionModelsForProvider, type TranscriptionProvider } from '../../../../services/llm/types/VoiceTypes';

export interface TranscriptionServiceDeps {
  getApiKey: (provider: string) => string | undefined;
}

export async function transcribeAudio(
  audioData: ArrayBuffer,
  mimeType: string,
  fileName: string,
  provider: string,
  model: string | undefined,
  deps: TranscriptionServiceDeps
): Promise<TranscriptionSegment[]> {
  const settings = buildSettings(provider, model, deps);
  const service = new SharedTranscriptionService(settings);
  const result = await service.transcribe({
    audioData,
    mimeType,
    fileName,
    provider: provider as TranscriptionProvider,
    model,
    requestWordTimestamps: true
  });

  return result.segments.map(segment => ({
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    text: segment.text
  }));
}

function buildSettings(
  provider: string,
  model: string | undefined,
  deps: TranscriptionServiceDeps
): LLMProviderSettings {
  const providerModels = getTranscriptionModelsForProvider(provider);
  const selectedModel = model || providerModels[0]?.id || '';

  return {
    ...DEFAULT_LLM_PROVIDER_SETTINGS,
    providers: {
      ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
      [provider]: {
        ...(DEFAULT_LLM_PROVIDER_SETTINGS.providers[provider] || {
          apiKey: '',
          enabled: false
        }),
        apiKey: deps.getApiKey(provider) || '',
        enabled: true
      }
    },
    defaultTranscriptionModel: selectedModel
      ? { provider, model: selectedModel }
      : undefined
  };
}

