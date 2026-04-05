import { requestUrl } from 'obsidian';
import { BaseTranscriptionAdapter } from '../BaseTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionSegment,
  TranscriptionWord
} from '../../types/VoiceTypes';

export class DeepgramTranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'deepgram';
  private readonly endpoint = 'https://api.deepgram.com/v1/listen';

  async transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<TranscriptionSegment[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set('model', request.model);
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('punctuate', 'true');
    url.searchParams.set('utterances', 'true');

    if (request.requestSpeakerLabels) {
      url.searchParams.set('diarize', 'true');
    }

    const response = await requestUrl({
      url: url.toString(),
      method: 'POST',
      headers: {
        Authorization: `Token ${this.config.apiKey}`,
        'Content-Type': chunk.mimeType
      },
      body: chunk.data
    });

    if (response.status !== 200) {
      throw new Error(`Deepgram transcription failed: HTTP ${response.status}`);
    }

    return this.parseResponse(response.json as unknown, chunk.durationSeconds);
  }

  private parseResponse(data: unknown, chunkDurationSeconds: number): TranscriptionSegment[] {
    const parsed = data as {
      results?: {
        utterances?: Array<{
          start?: unknown;
          end?: unknown;
          transcript?: unknown;
          confidence?: unknown;
          speaker?: unknown;
          words?: Array<{
            word?: unknown;
            punctuated_word?: unknown;
            start?: unknown;
            end?: unknown;
            confidence?: unknown;
            speaker?: unknown;
          }>;
        }>;
        channels?: Array<{
          alternatives?: Array<{
            transcript?: unknown;
            confidence?: unknown;
            words?: Array<{
              word?: unknown;
              punctuated_word?: unknown;
              start?: unknown;
              end?: unknown;
              confidence?: unknown;
              speaker?: unknown;
            }>;
          }>;
        }>;
      };
    };

    const utterances = parsed.results?.utterances;
    if (Array.isArray(utterances) && utterances.length > 0) {
      return utterances.map(utterance => ({
        startSeconds: typeof utterance.start === 'number' ? utterance.start : 0,
        endSeconds: typeof utterance.end === 'number' ? utterance.end : chunkDurationSeconds,
        text: typeof utterance.transcript === 'string' ? utterance.transcript.trim() : '',
        confidence: typeof utterance.confidence === 'number' ? utterance.confidence : undefined,
        speaker: typeof utterance.speaker === 'string' || typeof utterance.speaker === 'number'
          ? String(utterance.speaker)
          : undefined,
        words: this.parseWords(utterance.words)
      })).filter(segment => segment.text.length > 0);
    }

    const alternative = parsed.results?.channels?.[0]?.alternatives?.[0];
    if (!alternative || typeof alternative.transcript !== 'string') {
      return [];
    }

    const text = alternative.transcript.trim();
    if (!text) {
      return [];
    }

    const words = this.parseWords(alternative.words);
    return [{
      startSeconds: 0,
      endSeconds: chunkDurationSeconds,
      text,
      confidence: typeof alternative.confidence === 'number' ? alternative.confidence : undefined,
      words: words.length > 0 ? words : undefined
    }];
  }

  private parseWords(
    words: Array<{
      word?: unknown;
      punctuated_word?: unknown;
      start?: unknown;
      end?: unknown;
      confidence?: unknown;
      speaker?: unknown;
    }> | undefined
  ): TranscriptionWord[] {
    if (!Array.isArray(words)) {
      return [];
    }

    return words.flatMap(word => {
      if (typeof word.start !== 'number' || typeof word.end !== 'number') {
        return [];
      }

      const text = typeof word.punctuated_word === 'string'
        ? word.punctuated_word
        : typeof word.word === 'string'
          ? word.word
          : undefined;

      if (!text) {
        return [];
      }

      return [{
        text,
        startSeconds: word.start,
        endSeconds: word.end,
        confidence: typeof word.confidence === 'number' ? word.confidence : undefined,
        speaker: typeof word.speaker === 'string' || typeof word.speaker === 'number'
          ? String(word.speaker)
          : undefined
      }];
    });
  }
}
