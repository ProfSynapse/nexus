import { requestUrl } from 'obsidian';
import { BRAND_NAME } from '../../../../constants/branding';
import { BaseTranscriptionAdapter } from '../BaseTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionSegment
} from '../../types/VoiceTypes';
import { parseWhisperResponse } from '../../utils/WhisperResponseParser';

export class OpenRouterTranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'openrouter';
  private readonly endpoint = 'https://openrouter.ai/api/v1/audio/transcriptions';

  async transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<TranscriptionSegment[]> {
    const response = await requestUrl({
      url: this.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.config.httpReferer?.trim() || 'https://synapticlabs.ai',
        'X-Title': this.config.xTitle?.trim() || BRAND_NAME
      },
      body: JSON.stringify({
        model: request.model,
        input_audio: {
          data: arrayBufferToBase64(chunk.data),
          format: mimeToOpenRouterFormat(chunk.mimeType)
        }
      })
    });

    if (response.status !== 200) {
      throw new Error(`OpenRouter transcription failed: HTTP ${response.status}`);
    }

    return parseWhisperResponse(response.json as unknown, chunk.durationSeconds);
  }
}

function mimeToOpenRouterFormat(mimeType: string): string {
  const formats: Record<string, string> = {
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/flac': 'flac',
    'audio/webm': 'webm'
  };
  const format = formats[mimeType];
  if (!format) {
    throw new Error(`OpenRouter transcription does not support audio format "${mimeType}".`);
  }
  return format;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(index, index + chunkSize)));
  }

  return btoa(binary);
}
