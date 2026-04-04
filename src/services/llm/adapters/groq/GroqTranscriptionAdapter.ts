import { requestUrl } from 'obsidian';
import { BaseTranscriptionAdapter } from '../BaseTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionSegment,
  TranscriptionWord
} from '../../types/VoiceTypes';
import { buildMultipartFormData } from '../../utils/MultipartFormDataBuilder';

export class GroqTranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'groq';
  private readonly endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';

  async transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<TranscriptionSegment[]> {
    const fields = [
      {
        name: 'file',
        value: chunk.data,
        filename: this.buildChunkFileName(request.fileName, chunk.mimeType),
        contentType: chunk.mimeType
      },
      { name: 'model', value: request.model },
      { name: 'response_format', value: 'verbose_json' },
      { name: 'timestamp_granularities[]', value: 'segment' }
    ];

    if (request.requestWordTimestamps) {
      fields.push({ name: 'timestamp_granularities[]', value: 'word' });
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
      throw new Error(`Groq transcription failed: HTTP ${response.status}`);
    }

    return this.parseResponse(response.json as unknown, chunk.durationSeconds);
  }

  private parseResponse(data: unknown, chunkDurationSeconds: number): TranscriptionSegment[] {
    const parsed = data as {
      text?: unknown;
      words?: Array<{ word?: unknown; start?: unknown; end?: unknown; confidence?: unknown }>;
      segments?: Array<{ start?: unknown; end?: unknown; text?: unknown; avg_logprob?: unknown }>;
    };

    const words = this.parseWords(parsed.words);
    if (Array.isArray(parsed.segments)) {
      return parsed.segments.map(segment => {
        const start = typeof segment.start === 'number' ? segment.start : 0;
        const end = typeof segment.end === 'number' ? segment.end : chunkDurationSeconds;
        return {
          startSeconds: start,
          endSeconds: end,
          text: typeof segment.text === 'string' ? segment.text.trim() : '',
          confidence: typeof segment.avg_logprob === 'number' ? segment.avg_logprob : undefined,
          words: words.length > 0 ? words.filter(word =>
            word.startSeconds >= start && word.endSeconds <= end
          ) : undefined
        };
      }).filter(segment => segment.text.length > 0);
    }

    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!text) {
      return [];
    }

    return [{
      startSeconds: 0,
      endSeconds: chunkDurationSeconds,
      text,
      words: words.length > 0 ? words : undefined
    }];
  }

  private parseWords(
    words: Array<{ word?: unknown; start?: unknown; end?: unknown; confidence?: unknown }> | undefined
  ): TranscriptionWord[] {
    if (!Array.isArray(words)) {
      return [];
    }

    return words.flatMap(word => {
      if (typeof word.word !== 'string' || typeof word.start !== 'number' || typeof word.end !== 'number') {
        return [];
      }

      return [{
        text: word.word,
        startSeconds: word.start,
        endSeconds: word.end,
        confidence: typeof word.confidence === 'number' ? word.confidence : undefined
      }];
    });
  }
}

