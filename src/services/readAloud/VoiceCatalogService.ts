import { requestUrl } from 'obsidian';
import type { AppsSettings } from '../../types/apps/AppTypes';
import type { SpeechVoiceDeclaration } from '../llm/types/SpeechTypes';
import { getSpeechModel } from '../llm/types/SpeechTypes';

export interface VoiceCatalogOptions {
  appsSettings?: AppsSettings;
}

interface ElevenLabsVoiceResponse {
  voices?: unknown[];
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const getString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

export class VoiceCatalogService {
  private elevenLabsVoiceCache: SpeechVoiceDeclaration[] | null = null;

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
}
