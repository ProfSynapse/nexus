import type { SpeechProvider } from '../llm/types/SpeechTypes';
import type {
  ResolvedSpeechSynthesisRequest,
  SpeechAdapter,
  SpeechSynthesisResult
} from './SpeechSynthesisTypes';
import { ProviderHttpClient, ProviderHttpError } from '../llm/adapters/shared/ProviderHttpClient';
import { getSpeechOutputExtension } from '../llm/types/SpeechTypes';
import { wrapPcmAsWav } from './pcmToWav';

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

    const wantsPcm = getSpeechOutputExtension(this.provider, request.model) === 'wav';
    const response = await this.send(request, wantsPcm ? 'pcm' : 'mp3').catch(async (error: unknown) => {
      // A model the catalog has not met yet may be PCM only, as Gemini and HeyGen are.
      if (!wantsPcm && error instanceof ProviderHttpError && /response_format/i.test(error.technicalMessage)) {
        return this.send(request, 'pcm');
      }
      throw error;
    });

    const contentType = response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
    const isPcm = /audio\/(?:pcm|l16)/i.test(contentType);
    const audioData = isPcm
      ? wrapPcmAsWav(response.arrayBuffer, Number(/rate=(\d+)/i.exec(contentType)?.[1]) || undefined, Number(/channels=(\d+)/i.exec(contentType)?.[1]) || undefined)
      : response.arrayBuffer;

    return {
      provider: this.provider,
      model: request.model,
      voice: request.voice,
      audioData,
      mimeType: isPcm ? 'audio/wav' : 'audio/mpeg',
    };
  }

  private send(request: ResolvedSpeechSynthesisRequest, format: 'mp3' | 'pcm') {
    return ProviderHttpClient.requestOk({
      provider: this.provider,
      operation: 'speech generation',
      timeoutMs: 300_000,
      responseType: 'binary',
      url: this.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: format === 'mp3' ? 'audio/mpeg' : 'audio/pcm',
      },
      body: JSON.stringify({
        model: request.model,
        input: request.text,
        // Some models, such as Fish Audio's, take no voice at all.
        ...(request.voice ? { voice: request.voice } : {}),
        response_format: format,
      }),
    });
  }
}
