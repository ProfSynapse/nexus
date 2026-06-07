import { requestUrl } from 'obsidian';
import type { SpeechProvider } from '../llm/types/SpeechTypes';
import type {
  ResolvedSpeechSynthesisRequest,
  SpeechAdapter,
  SpeechSynthesisResult
} from './SpeechSynthesisTypes';

export interface OpenRouterSpeechAdapterConfig {
  apiKey: string;
}

export class OpenRouterSpeechAdapter implements SpeechAdapter {
  readonly provider: SpeechProvider = 'openrouter';
  private readonly endpoint = 'https://openrouter.ai/api/v1/audio/speech';

  constructor(private config: OpenRouterSpeechAdapterConfig) {}

  isAvailable(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async synthesize(request: ResolvedSpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    if (request.provider !== this.provider) {
      throw new Error(`OpenRouter speech adapter cannot synthesize provider "${request.provider}".`);
    }

    const response = await requestUrl({
      url: this.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        model: request.model,
        input: request.text,
        voice: request.voice,
        response_format: 'mp3',
      }),
    });

    if (response.status !== 200) {
      const errorText = typeof response.text === 'string' ? response.text : 'Unknown error';
      throw new Error(`OpenRouter speech failed: HTTP ${response.status}: ${errorText}`);
    }

    return {
      provider: this.provider,
      model: request.model,
      voice: request.voice,
      audioData: response.arrayBuffer,
      mimeType: 'audio/mpeg',
    };
  }
}
