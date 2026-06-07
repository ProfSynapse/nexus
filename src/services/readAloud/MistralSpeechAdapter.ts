import { requestUrl } from 'obsidian';
import {
  getSpeechModel,
  type SpeechProvider,
} from '../llm/types/SpeechTypes';
import type {
  ResolvedSpeechSynthesisRequest,
  SpeechAdapter,
  SpeechSynthesisResult
} from './SpeechSynthesisTypes';

export interface MistralSpeechAdapterConfig {
  apiKey: string;
}

interface MistralSpeechResponse {
  audio_data?: unknown;
}

export class MistralSpeechAdapter implements SpeechAdapter {
  readonly provider: SpeechProvider = 'mistral';
  private readonly endpoint = 'https://api.mistral.ai/v1/audio/speech';

  constructor(private config: MistralSpeechAdapterConfig) {}

  isAvailable(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async synthesize(request: ResolvedSpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    if (request.provider !== this.provider) {
      throw new Error(`Mistral speech adapter cannot synthesize provider "${request.provider}".`);
    }

    const declaration = getSpeechModel(request.provider, request.model);
    if (!declaration) {
      throw new Error(`Unsupported Mistral speech model "${request.model}".`);
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input: request.text,
      response_format: 'mp3',
    };

    if (request.voice) {
      body.voice_id = request.voice;
    }

    const response = await requestUrl({
      url: this.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.status !== 200) {
      const errorText = typeof response.text === 'string' ? response.text : 'Unknown error';
      throw new Error(`Mistral speech failed: HTTP ${response.status}: ${errorText}`);
    }

    const responseData = response.json as MistralSpeechResponse;
    const audioData = typeof responseData.audio_data === 'string'
      ? decodeBase64(responseData.audio_data)
      : response.arrayBuffer;

    return {
      provider: this.provider,
      model: request.model,
      voice: request.voice,
      audioData,
      mimeType: 'audio/mpeg',
    };
  }
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
