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

    const response = await requestUrl({
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

    if (response.status !== 200) {
      const errorText = typeof response.text === 'string' ? response.text : 'Unknown error';
      throw new Error(`Google speech failed: HTTP ${response.status}: ${errorText}`);
    }

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

function wrapPcmAsWav(pcmAudio: ArrayBuffer): ArrayBuffer {
  const sampleRate = 24000;
  const channelCount = 1;
  const bitsPerSample = 16;
  const headerSize = 44;
  const pcmBytes = new Uint8Array(pcmAudio);
  const wavBytes = new Uint8Array(headerSize + pcmBytes.byteLength);
  const view = new DataView(wavBytes.buffer);

  writeAscii(wavBytes, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeAscii(wavBytes, 8, 'WAVE');
  writeAscii(wavBytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * (bitsPerSample / 8), true);
  view.setUint16(32, channelCount * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(wavBytes, 36, 'data');
  view.setUint32(40, pcmBytes.byteLength, true);
  wavBytes.set(pcmBytes, headerSize);

  return wavBytes.buffer;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
