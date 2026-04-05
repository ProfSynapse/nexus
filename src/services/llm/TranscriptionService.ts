import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { OpenAITranscriptionAdapter } from './adapters/openai/OpenAITranscriptionAdapter';
import { GroqTranscriptionAdapter } from './adapters/groq/GroqTranscriptionAdapter';
import { MistralTranscriptionAdapter } from './adapters/mistral/MistralTranscriptionAdapter';
import { DeepgramTranscriptionAdapter } from './adapters/deepgram/DeepgramTranscriptionAdapter';
import { AssemblyAITranscriptionAdapter } from './adapters/assemblyai/AssemblyAITranscriptionAdapter';
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

  private static cachedInstance: TranscriptionService | null = null;
  private static cachedSettingsFingerprint: string | null = null;

  /**
   * Returns a cached TranscriptionService if settings haven't changed,
   * or creates a new one if they have. Avoids re-instantiating adapters
   * on every execution when provider config is stable.
   */
  static createOrReuse(settings: LLMProviderSettings | null): TranscriptionService {
    const fingerprint = TranscriptionService.computeFingerprint(settings);
    if (
      TranscriptionService.cachedInstance &&
      TranscriptionService.cachedSettingsFingerprint === fingerprint
    ) {
      return TranscriptionService.cachedInstance;
    }

    TranscriptionService.cachedInstance = new TranscriptionService(settings);
    TranscriptionService.cachedSettingsFingerprint = fingerprint;
    return TranscriptionService.cachedInstance;
  }

  private static computeFingerprint(settings: LLMProviderSettings | null): string {
    if (!settings?.providers) {
      return 'null';
    }

    const parts: string[] = [];
    const providers = settings.providers;
    for (const key of Object.keys(providers).sort()) {
      const config = providers[key as keyof typeof providers];
      if (config && typeof config === 'object') {
        const c = config as { enabled?: boolean; apiKey?: string };
        parts.push(`${key}:${c.enabled ?? false}:${c.apiKey ?? ''}`);
      }
    }
    return parts.join('|');
  }

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
