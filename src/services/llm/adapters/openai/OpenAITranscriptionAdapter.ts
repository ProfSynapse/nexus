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

/**
 * Response format per model. OpenAI's transcription models no longer share one
 * contract:
 *
 * - `whisper-1` is the only model that still accepts `verbose_json`, and the
 *   only one that returns word timestamps.
 * - `gpt-4o-transcribe-diarize` speaks `diarized_json`: segments with speaker
 *   labels and timing, but no word-level detail.
 * - The `gpt-transcribe` generation returns plain JSON with no timing at all,
 *   and rejects `verbose_json` outright rather than degrading to it.
 */
type OpenAITranscriptionResponseFormat = 'verbose_json' | 'diarized_json' | 'json';

const RESPONSE_FORMAT_BY_MODEL: Record<string, OpenAITranscriptionResponseFormat> = {
  'whisper-1': 'verbose_json',
  'gpt-4o-transcribe-diarize': 'diarized_json'
};

/** Diarization models reject `prompt` with a 400 rather than ignoring it. */
const MODELS_REJECTING_PROMPT = new Set(['gpt-4o-transcribe-diarize']);

export class OpenAITranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'openai';
  private readonly endpoint = 'https://api.openai.com/v1/audio/transcriptions';

  async transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<TranscriptionSegment[]> {
    const responseFormat = RESPONSE_FORMAT_BY_MODEL[request.model] ?? 'json';

    const fields = [
      {
        name: 'file',
        value: chunk.data,
        filename: this.buildChunkFileName(request.fileName, chunk.mimeType),
        contentType: chunk.mimeType
      },
      { name: 'model', value: request.model }
    ];

    if (request.prompt?.trim() && !MODELS_REJECTING_PROMPT.has(request.model)) {
      fields.push({ name: 'prompt', value: request.prompt.trim() });
    }

    fields.push({ name: 'response_format', value: responseFormat });

    if (responseFormat === 'verbose_json') {
      fields.push({ name: 'timestamp_granularities[]', value: 'segment' });
      if (request.requestWordTimestamps === true) {
        fields.push({ name: 'timestamp_granularities[]', value: 'word' });
      }
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

    return parseWhisperResponse(response.json as unknown, chunk.durationSeconds, {
      extractSpeakers: responseFormat === 'diarized_json'
    });
  }
}

