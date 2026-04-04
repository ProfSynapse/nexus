import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { OpenAITranscriptionAdapter } from './adapters/openai/OpenAITranscriptionAdapter';
import { GroqTranscriptionAdapter } from './adapters/groq/GroqTranscriptionAdapter';
import { MistralTranscriptionAdapter } from './adapters/mistral/MistralTranscriptionAdapter';
import { DeepgramTranscriptionAdapter } from './adapters/deepgram/DeepgramTranscriptionAdapter';
import { AssemblyAITranscriptionAdapter } from './adapters/assemblyai/AssemblyAITranscriptionAdapter';
import { GoogleTranscriptionAdapter } from './adapters/google/GoogleTranscriptionAdapter';
import { OpenRouterTranscriptionAdapter } from './adapters/openrouter/OpenRouterTranscriptionAdapter';
import type { BaseTranscriptionAdapter } from './adapters/BaseTranscriptionAdapter';
import {
  getTranscriptionModel,
  getTranscriptionModelsForProvider,
  resolveDefaultTranscriptionSelection,
  type TranscriptionProvider,
  type TranscriptionProviderAvailability,
  type TranscriptionRequest,
  type TranscriptionResult,
  type TranscriptionSegment
} from './types/VoiceTypes';
import { chunkAudio } from './utils/AudioChunkingService';

export class TranscriptionService {
  private adapters = new Map<TranscriptionProvider, BaseTranscriptionAdapter>();

  constructor(private llmSettings: LLMProviderSettings | null = null) {
    this.initializeAdapters();
  }

  private initializeAdapters(): void {
    if (!this.llmSettings) {
      return;
    }

    const openAIConfig = this.llmSettings.providers?.openai;
    if (openAIConfig?.enabled && openAIConfig.apiKey) {
      this.adapters.set('openai', new OpenAITranscriptionAdapter({
        apiKey: openAIConfig.apiKey
      }));
    }

    const groqConfig = this.llmSettings.providers?.groq;
    if (groqConfig?.enabled && groqConfig.apiKey) {
      this.adapters.set('groq', new GroqTranscriptionAdapter({
        apiKey: groqConfig.apiKey
      }));
    }

    const mistralConfig = this.llmSettings.providers?.mistral;
    if (mistralConfig?.enabled && mistralConfig.apiKey) {
      this.adapters.set('mistral', new MistralTranscriptionAdapter({
        apiKey: mistralConfig.apiKey
      }));
    }

    const deepgramConfig = this.llmSettings.providers?.deepgram;
    if (deepgramConfig?.enabled && deepgramConfig.apiKey) {
      this.adapters.set('deepgram', new DeepgramTranscriptionAdapter({
        apiKey: deepgramConfig.apiKey
      }));
    }

    const assemblyAIConfig = this.llmSettings.providers?.assemblyai;
    if (assemblyAIConfig?.enabled && assemblyAIConfig.apiKey) {
      this.adapters.set('assemblyai', new AssemblyAITranscriptionAdapter({
        apiKey: assemblyAIConfig.apiKey
      }));
    }

    const googleConfig = this.llmSettings.providers?.google;
    if (googleConfig?.enabled && googleConfig.apiKey) {
      this.adapters.set('google', new GoogleTranscriptionAdapter({
        apiKey: googleConfig.apiKey
      }));
    }

    const openRouterConfig = this.llmSettings.providers?.openrouter;
    if (openRouterConfig?.enabled && openRouterConfig.apiKey) {
      this.adapters.set('openrouter', new OpenRouterTranscriptionAdapter({
        apiKey: openRouterConfig.apiKey,
        httpReferer: openRouterConfig.httpReferer,
        xTitle: openRouterConfig.xTitle
      }));
    }
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const resolved = resolveDefaultTranscriptionSelection(this.llmSettings, request.provider, request.model);
    if (!resolved.provider || !resolved.model) {
      throw new Error(
        'No transcription provider/model available. Configure a default transcription provider in settings.'
      );
    }

    const adapter = this.adapters.get(resolved.provider);
    if (!adapter || !adapter.isAvailable()) {
      throw new Error(`Transcription provider "${resolved.provider}" is not configured or not enabled`);
    }

    const declaration = getTranscriptionModel(resolved.provider, resolved.model);
    if (!declaration) {
      throw new Error(`Unsupported transcription model "${resolved.model}" for provider "${resolved.provider}"`);
    }

    const chunks = await chunkAudio(request.audioData, request.mimeType);
    const mergedSegments: TranscriptionSegment[] = [];

    for (const chunk of chunks) {
      const segments = await adapter.transcribeChunk(chunk, {
        ...request,
        provider: resolved.provider,
        model: resolved.model,
        requestWordTimestamps: request.requestWordTimestamps === true && declaration.supportsWordTimestamps
      });

      for (const segment of segments) {
        mergedSegments.push({
          ...segment,
          startSeconds: segment.startSeconds + chunk.startSeconds,
          endSeconds: segment.endSeconds + chunk.startSeconds,
          words: segment.words?.map(word => ({
            ...word,
            startSeconds: word.startSeconds + chunk.startSeconds,
            endSeconds: word.endSeconds + chunk.startSeconds
          }))
        });
      }
    }

    return {
      provider: resolved.provider,
      model: resolved.model,
      text: mergedSegments.map(segment => segment.text).join(' ').replace(/\s+/g, ' ').trim(),
      durationSeconds: mergedSegments.length > 0
        ? Math.max(...mergedSegments.map(segment => segment.endSeconds))
        : undefined,
      segments: mergedSegments
    };
  }

  getAvailableProviders(): TranscriptionProviderAvailability[] {
    const providers: TranscriptionProviderAvailability[] = [];

    for (const provider of Array.from(this.adapters.keys())) {
      const adapter = this.adapters.get(provider);
      if (!adapter) {
        continue;
      }

      providers.push({
        provider,
        available: adapter.isAvailable(),
        models: this.getModelsForProvider(provider),
        error: adapter.isAvailable() ? undefined : 'API key not configured or provider disabled'
      });
    }

    return providers;
  }

  getModelsForProvider(provider: TranscriptionProvider) {
    const modelConfig = this.llmSettings?.providers?.[provider]?.models;
    return getTranscriptionModelsForProvider(provider).filter(model => modelConfig?.[model.id]?.enabled !== false);
  }
}
