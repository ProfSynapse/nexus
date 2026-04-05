import { requestUrl } from 'obsidian';
import { BaseTranscriptionAdapter } from '../BaseTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionSegment
} from '../../types/VoiceTypes';
import { buildMultipartFormData } from '../../utils/MultipartFormDataBuilder';
import { parseWhisperResponse } from '../../utils/WhisperResponseParser';

export class MistralTranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'mistral';
  private readonly endpoint = 'https://api.mistral.ai/v1/audio/transcriptions';

  async transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<TranscriptionSegment[]> {
    // Mistral accepts only ONE granularity value (no arrays, no PHP-style `[]` fields).
    // Use 'word' when word timestamps requested (includes segment output), else 'segment'.
    const granularity = request.requestWordTimestamps ? 'word' : 'segment';

    const fields = [
      {
        name: 'file',
        value: chunk.data,
        filename: this.buildChunkFileName(request.fileName, chunk.mimeType),
        contentType: chunk.mimeType
      },
      { name: 'model', value: request.model },
      { name: 'response_format', value: 'verbose_json' },
      { name: 'timestamp_granularities', value: granularity }
    ];

    if (request.requestSpeakerLabels) {
      fields.push({ name: 'diarize', value: 'true' });
    }

    if (request.prompt?.trim()) {
      fields.push({ name: 'prompt', value: request.prompt.trim() });
    }

    const { body, contentType } = buildMultipartFormData(fields);
    const response = await requestUrl({
      url: this.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': contentType
      },
      body
    });

    if (response.status !== 200) {
      throw new Error(`Mistral transcription failed: HTTP ${response.status}`);
    }

    return parseWhisperResponse(response.json as unknown, chunk.durationSeconds, {
      useSegmentConfidence: true,
      extractSpeakers: true
    });
  }
}
