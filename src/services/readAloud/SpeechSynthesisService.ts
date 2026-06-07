import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import {
  buildSpeechProviderAvailability,
  getSpeechModel,
  resolveDefaultSpeechSelection,
  type SpeechAppCapabilityStates,
  type ResolvedSpeechSelection,
  type SpeechProvider,
} from '../llm/types/SpeechTypes';
import { ElevenLabsSpeechAdapter } from './ElevenLabsSpeechAdapter';
import { MistralSpeechAdapter } from './MistralSpeechAdapter';
import { OpenAISpeechAdapter } from './OpenAISpeechAdapter';
import { OpenRouterSpeechAdapter } from './OpenRouterSpeechAdapter';
import type {
  ResolvedSpeechSynthesisRequest,
  SpeechAdapter,
  SpeechSynthesisRequest,
  SpeechSynthesisServiceOptions,
  SpeechSynthesisResult
} from './SpeechSynthesisTypes';

export class SpeechSynthesisService {
  private adapters = new Map<SpeechProvider, SpeechAdapter>();

  constructor(
    private llmSettings: LLMProviderSettings | null = null,
    private options: SpeechSynthesisServiceOptions = {}
  ) {
    this.initializeAdapters();
  }

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    const resolved = this.resolveRequest(request);
    const adapter = this.adapters.get(resolved.provider);
    if (!adapter || !adapter.isAvailable()) {
      throw new Error(`Speech provider "${resolved.provider}" is not configured or not enabled.`);
    }

    return adapter.synthesize(resolved);
  }

  resolveRequest(request: SpeechSynthesisRequest): ResolvedSpeechSynthesisRequest {
    const selection = this.resolveSelection(request);
    if (selection.status === 'invalid') {
      throw new Error(selection.reason ?? 'Selected speech provider is not available.');
    }

    if (!selection.provider || !selection.model) {
      throw new Error('No speech provider/model available. Configure a speech provider in Voice settings.');
    }

    const model = getSpeechModel(selection.provider, selection.model);
    if (!model && selection.provider !== 'openrouter') {
      throw new Error(`Unsupported speech model "${selection.model}" for provider "${selection.provider}".`);
    }

    return {
      text: request.text,
      provider: selection.provider,
      model: selection.model,
      voice: request.voice || selection.voice || model?.defaultVoice || getProviderDefaultVoice(selection.provider, selection.model),
    };
  }

  private resolveSelection(request: SpeechSynthesisRequest): ResolvedSpeechSelection {
    if (request.provider || request.model) {
      return this.resolveExplicitSelection(request);
    }

    const availability = buildSpeechProviderAvailability(this.llmSettings, this.getAppStates());
    const resolved = resolveDefaultSpeechSelection(this.llmSettings, availability);
    if (resolved.status === 'invalid') {
      throw new Error(resolved.reason ?? 'Selected speech provider is not available.');
    }

    return resolved;
  }

  private resolveExplicitSelection(request: SpeechSynthesisRequest): ResolvedSpeechSelection {
    const provider = request.provider as SpeechProvider | undefined;
    if (!provider) {
      return {
        model: request.model,
        voice: request.voice,
        source: 'user',
        status: 'invalid',
        reason: 'Speech provider is required when a model is specified.',
      };
    }

    const availability = buildSpeechProviderAvailability(this.llmSettings, this.getAppStates());
    const providerAvailability = availability.find(item => item.provider === provider);
    if (!providerAvailability?.enabled || !providerAvailability.configured) {
      return {
        provider,
        model: request.model,
        voice: request.voice,
        source: 'user',
        status: 'invalid',
        reason: `Speech provider "${provider}" is not enabled and configured.`
      };
    }

    const settingsDefault = this.llmSettings?.defaultSpeechModel;
    const defaultModel = settingsDefault?.provider === provider ? settingsDefault.model : undefined;
    const model = request.model || defaultModel || providerAvailability.models?.[0]?.id;
    if (!model) {
      return {
        provider,
        voice: request.voice,
        source: 'user',
        status: 'invalid',
        reason: `No speech model is available for provider "${provider}".`,
      };
    }

    if (provider !== 'openrouter' && !providerAvailability.models?.some(candidate => candidate.id === model)) {
      return {
        provider,
        model,
        voice: request.voice,
        source: 'user',
        status: 'invalid',
        reason: `Speech model "${model}" is not available for provider "${provider}".`
      };
    }

    const modelDefaultVoice = getSpeechModel(provider, model)?.defaultVoice;
    const settingsDefaultVoice = settingsDefault?.provider === provider && settingsDefault.model === model
      ? settingsDefault.voice
      : undefined;

    return {
      provider,
      model,
      voice: request.voice || settingsDefaultVoice || modelDefaultVoice,
      source: 'user',
      status: 'resolved',
    };
  }

  private initializeAdapters(): void {
    const openAIConfig = this.llmSettings?.providers?.openai;
    if (openAIConfig?.enabled && openAIConfig.apiKey) {
      this.adapters.set('openai', new OpenAISpeechAdapter({
        apiKey: openAIConfig.apiKey
      }));
    }

    const mistralConfig = this.llmSettings?.providers?.mistral;
    if (mistralConfig?.enabled && mistralConfig.apiKey) {
      this.adapters.set('mistral', new MistralSpeechAdapter({
        apiKey: mistralConfig.apiKey
      }));
    }

    const openRouterConfig = this.llmSettings?.providers?.openrouter;
    if (openRouterConfig?.enabled && openRouterConfig.apiKey) {
      this.adapters.set('openrouter', new OpenRouterSpeechAdapter({
        apiKey: openRouterConfig.apiKey
      }));
    }

    const elevenLabsConfig = this.options.appsSettings?.apps.elevenlabs;
    const elevenLabsApiKey = elevenLabsConfig?.credentials.apiKey;
    if (elevenLabsConfig?.enabled && elevenLabsApiKey) {
      this.adapters.set('elevenlabs', new ElevenLabsSpeechAdapter({
        apiKey: elevenLabsApiKey
      }));
    }
  }

  private getAppStates(): SpeechAppCapabilityStates {
    const elevenLabsConfig = this.options.appsSettings?.apps.elevenlabs;
    if (!elevenLabsConfig) {
      return {};
    }

    return {
      elevenlabs: {
        enabled: elevenLabsConfig.enabled,
        configured: !!elevenLabsConfig.credentials.apiKey?.trim(),
      }
    };
  }
}

function getProviderDefaultVoice(provider: SpeechProvider, model: string): string {
  if (provider === 'openrouter') {
    if (model.startsWith('microsoft/')) {
      return 'en-US-Harper:MAI-Voice-2';
    }

    return 'alloy';
  }

  return '';
}
