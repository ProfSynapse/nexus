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

export class OpenAITranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'openai';
  private readonly endpoint = 'https://api.openai.com/v1/audio/transcriptions';

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
      { name: 'model', value: request.model }
    ];

    const wantsWords = request.model === 'whisper-1' && request.requestWordTimestamps === true;
    if (request.prompt?.trim()) {
      fields.push({ name: 'prompt', value: request.prompt.trim() });
    }

    if (request.model === 'whisper-1') {
      fields.push({ name: 'response_format', value: 'verbose_json' });
      fields.push({ name: 'timestamp_granularities[]', value: 'segment' });
      if (wantsWords) {
        fields.push({ name: 'timestamp_granularities[]', value: 'word' });
      }
    } else {
      fields.push({ name: 'response_format', value: 'json' });
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
      throw new Error(`OpenAI transcription failed: HTTP ${response.status}`);
    }

    return this.parseResponse(response.json as unknown, chunk.durationSeconds);
  }

  private parseResponse(data: unknown, chunkDurationSeconds: number): TranscriptionSegment[] {
    const parsed = data as {
      text?: unknown;
      duration?: unknown;
      words?: Array<{ word?: unknown; start?: unknown; end?: unknown }>;
      segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
    };

    const words = this.parseWords(parsed.words);
    if (Array.isArray(parsed.segments)) {
      return parsed.segments.map(segment => ({
        startSeconds: typeof segment.start === 'number' ? segment.start : 0,
        endSeconds: typeof segment.end === 'number' ? segment.end : chunkDurationSeconds,
        text: typeof segment.text === 'string' ? segment.text.trim() : '',
        words: words.length > 0 ? words.filter(word =>
          word.startSeconds >= (typeof segment.start === 'number' ? segment.start : 0) &&
          word.endSeconds <= (typeof segment.end === 'number' ? segment.end : chunkDurationSeconds)
        ) : undefined
      })).filter(segment => segment.text.length > 0);
    }

    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!text) {
      return [];
    }

    const endSeconds = typeof parsed.duration === 'number' ? parsed.duration : chunkDurationSeconds;
    return [{
      startSeconds: 0,
      endSeconds,
      text,
      words: words.length > 0 ? words : undefined
    }];
  }

  private parseWords(words: Array<{ word?: unknown; start?: unknown; end?: unknown }> | undefined): TranscriptionWord[] {
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
        endSeconds: word.end
      }];
    });
  }
}

