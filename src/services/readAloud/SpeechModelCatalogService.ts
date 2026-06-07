import { requestUrl } from 'obsidian';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import {
  getSpeechModelsForProvider,
  type SpeechModelDeclaration,
  type SpeechProvider
} from '../llm/types/SpeechTypes';

interface OpenRouterModelsResponse {
  data?: unknown[];
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const getString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

export class SpeechModelCatalogService {
  private openRouterSpeechModelsCache: SpeechModelDeclaration[] | null = null;

  async getModels(
    provider: SpeechProvider,
    llmSettings: LLMProviderSettings
  ): Promise<SpeechModelDeclaration[]> {
    if (provider !== 'openrouter') {
      return getSpeechModelsForProvider(provider);
    }

    const dynamicModels = await this.getOpenRouterSpeechModels(llmSettings);
    return dynamicModels.length > 0
      ? dynamicModels
      : getSpeechModelsForProvider(provider);
  }

  private async getOpenRouterSpeechModels(llmSettings: LLMProviderSettings): Promise<SpeechModelDeclaration[]> {
    if (this.openRouterSpeechModelsCache) {
      return this.openRouterSpeechModelsCache;
    }

    const providerConfig = llmSettings.providers.openrouter;
    const apiKey = providerConfig?.apiKey;
    if (!providerConfig?.enabled || !apiKey) {
      return [];
    }

    const response = await requestUrl({
      url: 'https://openrouter.ai/api/v1/models?output_modalities=speech',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.status !== 200) {
      return [];
    }

    const responseData = response.json as OpenRouterModelsResponse;
    const rawModels = Array.isArray(responseData.data) ? responseData.data : [];
    const models = rawModels
      .map((model): SpeechModelDeclaration | null => {
        if (!isRecord(model)) {
          return null;
        }

        const id = getString(model.id);
        const name = getString(model.name, id);
        if (!id || !name) {
          return null;
        }

        return {
          provider: 'openrouter',
          id,
          name,
          execution: 'speech-api',
          defaultVoice: getDefaultOpenRouterVoice(id),
          supportsDynamicVoices: true,
          supportsStreaming: true,
          supportsInstructions: id.startsWith('openai/'),
          supportsSpeed: id.startsWith('openai/') || id.startsWith('microsoft/'),
          responseFormats: ['mp3', 'pcm'],
        };
      })
      .filter((model): model is SpeechModelDeclaration => model !== null);

    this.openRouterSpeechModelsCache = models;
    return models;
  }
}

function getDefaultOpenRouterVoice(modelId: string): string {
  if (modelId.startsWith('openai/')) {
    return 'alloy';
  }

  if (modelId.startsWith('microsoft/')) {
    return 'en-US-Harper:MAI-Voice-2';
  }

  return 'alloy';
}
