import { requestUrl } from 'obsidian';
import type { AppsSettings } from '../../types/apps/AppTypes';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import type { SpeechVoiceDeclaration } from '../llm/types/SpeechTypes';
import { getSpeechModel } from '../llm/types/SpeechTypes';

export interface VoiceCatalogOptions {
  appsSettings?: AppsSettings;
  llmSettings?: LLMProviderSettings;
}

interface ElevenLabsVoiceResponse {
  voices?: unknown[];
}

interface MistralVoiceResponse {
  items?: unknown[];
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const getString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

export class VoiceCatalogService {
  private elevenLabsVoiceCache: SpeechVoiceDeclaration[] | null = null;
  private mistralVoiceCache: SpeechVoiceDeclaration[] | null = null;

  async getVoices(
    provider: string | undefined,
    modelId: string | undefined,
    options: VoiceCatalogOptions = {}
  ): Promise<SpeechVoiceDeclaration[]> {
    if (!provider || !modelId) {
      return [];
    }

    if (provider === 'elevenlabs') {
      const dynamicVoices = await this.getElevenLabsVoices(options.appsSettings);
      if (dynamicVoices.length > 0) {
        return dynamicVoices;
      }
    }

    if (provider === 'mistral') {
      const dynamicVoices = await this.getMistralVoices(options.llmSettings);
      if (dynamicVoices.length > 0) {
        return dynamicVoices;
      }
    }

    return getSpeechModel(provider, modelId)?.voices ?? [];
  }

  private async getElevenLabsVoices(appsSettings: AppsSettings | undefined): Promise<SpeechVoiceDeclaration[]> {
    if (this.elevenLabsVoiceCache) {
      return this.elevenLabsVoiceCache;
    }

    const appConfig = appsSettings?.apps.elevenlabs;
    const apiKey = appConfig?.credentials.apiKey;
    if (!appConfig?.enabled || !apiKey) {
      return [];
    }

    const response = await requestUrl({
      url: 'https://api.elevenlabs.io/v1/voices',
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
      },
    });

    if (response.status !== 200) {
      return [];
    }

    const responseData = response.json as ElevenLabsVoiceResponse;
    const rawVoices = Array.isArray(responseData.voices) ? responseData.voices : [];
    const voices = rawVoices
      .map((voice): SpeechVoiceDeclaration | null => {
        if (!isRecord(voice)) {
          return null;
        }

        const id = getString(voice.voice_id);
        const name = getString(voice.name);
        if (!id || !name) {
          return null;
        }

        return {
          id,
          name,
          description: getString(voice.category),
        };
      })
      .filter((voice): voice is SpeechVoiceDeclaration => voice !== null);

    this.elevenLabsVoiceCache = voices;
    return voices;
  }

  private async getMistralVoices(llmSettings: LLMProviderSettings | undefined): Promise<SpeechVoiceDeclaration[]> {
    if (this.mistralVoiceCache) {
      return this.mistralVoiceCache;
    }

    const providerConfig = llmSettings?.providers?.mistral;
    const apiKey = providerConfig?.apiKey;
    if (!providerConfig?.enabled || !apiKey) {
      return [];
    }

    const response = await requestUrl({
      url: 'https://api.mistral.ai/v1/audio/voices',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.status !== 200) {
      return [];
    }

    const responseData = response.json as MistralVoiceResponse;
    const rawVoices = Array.isArray(responseData.items) ? responseData.items : [];
    const voices = rawVoices
      .map((voice): SpeechVoiceDeclaration | null => {
        if (!isRecord(voice)) {
          return null;
        }

        const id = getString(voice.id);
        const name = getString(voice.name, id);
        if (!id || !name) {
          return null;
        }

        return { id, name };
      })
      .filter((voice): voice is SpeechVoiceDeclaration => voice !== null);

    this.mistralVoiceCache = voices;
    return voices;
  }
}
