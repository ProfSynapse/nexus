import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import {
  buildSpeechProviderAvailability,
  getSpeechModel,
  resolveDefaultSpeechSelection,
  type ResolvedSpeechSelection,
  type SpeechProvider,
} from '../llm/types/SpeechTypes';
import { OpenAISpeechAdapter } from './OpenAISpeechAdapter';
import type {
  ResolvedSpeechSynthesisRequest,
  SpeechAdapter,
  SpeechSynthesisRequest,
  SpeechSynthesisResult
} from './SpeechSynthesisTypes';

export class SpeechSynthesisService {
  private adapters = new Map<SpeechProvider, SpeechAdapter>();

  constructor(private llmSettings: LLMProviderSettings | null = null) {
    this.initializeAdapters();
  }

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    const resolved = this.resolveRequest(request);
    const adapter = this.adapters.get(resolved.provider);
    if (!adapter || !adapter.isAvailable()) {
      if (resolved.provider !== 'openai') {
        throw new Error(`Speech provider "${resolved.provider}" is not supported for read aloud yet.`);
      }
      throw new Error(`Speech provider "${resolved.provider}" is not configured or not enabled.`);
    }

    return adapter.synthesize(resolved);
  }

  resolveRequest(request: SpeechSynthesisRequest): ResolvedSpeechSynthesisRequest {
    const selection = this.resolveSelection(request);
    if (!selection.provider || !selection.model) {
      throw new Error('No speech provider/model available. Configure a speech provider in Voice settings.');
    }

    const model = getSpeechModel(selection.provider, selection.model);
    if (!model) {
      throw new Error(`Unsupported speech model "${selection.model}" for provider "${selection.provider}".`);
    }

    return {
      text: request.text,
      provider: selection.provider,
      model: selection.model,
      voice: request.voice || selection.voice || model.defaultVoice || '',
    };
  }

  private resolveSelection(request: SpeechSynthesisRequest): ResolvedSpeechSelection {
    if (request.provider || request.model) {
      return {
        provider: request.provider as SpeechProvider | undefined,
        model: request.model,
        voice: request.voice,
        source: 'user',
        status: request.provider && request.model ? 'resolved' : 'invalid',
        reason: request.provider && request.model ? undefined : 'Speech provider and model are both required.',
      };
    }

    const availability = buildSpeechProviderAvailability(this.llmSettings);
    const resolved = resolveDefaultSpeechSelection(this.llmSettings, availability);
    if (resolved.status === 'invalid') {
      throw new Error(resolved.reason ?? 'Selected speech provider is not available.');
    }

    return resolved;
  }

  private initializeAdapters(): void {
    const openAIConfig = this.llmSettings?.providers?.openai;
    if (openAIConfig?.enabled && openAIConfig.apiKey) {
      this.adapters.set('openai', new OpenAISpeechAdapter({
        apiKey: openAIConfig.apiKey
      }));
    }
  }
}
