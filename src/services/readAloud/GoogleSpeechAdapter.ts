import {
  getSpeechModel,
  type SpeechProvider,
} from '../llm/types/SpeechTypes';
import type {
  ResolvedSpeechSynthesisRequest,
  SpeechAdapter,
  SpeechSynthesisResult
} from './SpeechSynthesisTypes';
import { ProviderHttpClient } from '../llm/adapters/shared/ProviderHttpClient';
import { wrapPcmAsWav } from './pcmToWav';

export interface GoogleSpeechAdapterConfig {
  apiKey: string;
}

interface GoogleGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          data?: unknown;
          mimeType?: unknown;
        };
      }>;
    };
  }>;
}

export class GoogleSpeechAdapter implements SpeechAdapter {
  readonly provider: SpeechProvider = 'google';
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(private config: GoogleSpeechAdapterConfig) {}

  isAvailable(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async synthesize(request: ResolvedSpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    if (request.provider !== this.provider) {
      throw new Error(`Google speech adapter cannot synthesize provider "${request.provider}".`);
    }

    const declaration = getSpeechModel(request.provider, request.model);
    if (!declaration) {
      throw new Error(`Unsupported Google speech model "${request.model}".`);
    }

    const response = await ProviderHttpClient.requestOk({
      provider: 'google',
      operation: 'speech generation',
      timeoutMs: 300_000,
      url: `${this.baseUrl}/models/${request.model}:generateContent`,
      method: 'POST',
      headers: {
        'x-goog-api-key': this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: request.text }]
        }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: request.voice || declaration.defaultVoice,
              },
            },
          },
        },
        model: request.model,
      }),
    });

    const data = getInlineAudioData(response.json as GoogleGenerateContentResponse);
    const pcmAudio = decodeBase64(data);
    const wavAudio = wrapPcmAsWav(pcmAudio);

    return {
      provider: this.provider,
      model: request.model,
      voice: request.voice || declaration.defaultVoice || '',
      audioData: wavAudio,
      mimeType: 'audio/wav',
    };
  }
}

function getInlineAudioData(response: GoogleGenerateContentResponse): string {
  const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('Google speech response did not include inline audio data.');
  }

  return data;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
