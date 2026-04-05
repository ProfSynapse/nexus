/**
 * Shared parser for Whisper-compatible transcription API responses.
 *
 * Used by OpenAI, Groq, and Mistral adapters which all return the same
 * verbose_json structure: { text, segments[], words[] }.
 * Adapter-specific fields (confidence, speaker) are handled via options.
 */

import type { TranscriptionSegment, TranscriptionWord } from '../types/VoiceTypes';

export interface WhisperParseOptions {
  /** Extract avg_logprob from segments as confidence (Groq) */
  useLogProbAsConfidence?: boolean;
  /** Extract per-segment confidence field (Mistral) */
  useSegmentConfidence?: boolean;
  /** Extract speaker labels from words and segments (Mistral) */
  extractSpeakers?: boolean;
}

interface RawWhisperResponse {
  text?: unknown;
  duration?: unknown;
  words?: RawWhisperWord[];
  segments?: RawWhisperSegment[];
}

interface RawWhisperWord {
  word?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
  speaker?: unknown;
}

interface RawWhisperSegment {
  start?: unknown;
  end?: unknown;
  text?: unknown;
  avg_logprob?: unknown;
  confidence?: unknown;
  speaker?: unknown;
}

/**
 * Parse a Whisper-format verbose_json response into TranscriptionSegments.
 */
export function parseWhisperResponse(
  data: unknown,
  chunkDurationSeconds: number,
  options: WhisperParseOptions = {}
): TranscriptionSegment[] {
  const parsed = data as RawWhisperResponse;
  const words = parseWhisperWords(parsed.words, options);

  if (Array.isArray(parsed.segments)) {
    return parsed.segments.map(segment => {
      const start = typeof segment.start === 'number' ? segment.start : 0;
      const end = typeof segment.end === 'number' ? segment.end : chunkDurationSeconds;

      let confidence: number | undefined;
      if (options.useLogProbAsConfidence && typeof segment.avg_logprob === 'number') {
        confidence = segment.avg_logprob;
      } else if (options.useSegmentConfidence && typeof segment.confidence === 'number') {
        confidence = segment.confidence;
      }

      return {
        startSeconds: start,
        endSeconds: end,
        text: typeof segment.text === 'string' ? segment.text.trim() : '',
        confidence,
        speaker: options.extractSpeakers && typeof segment.speaker === 'string'
          ? segment.speaker
          : undefined,
        words: words.length > 0
          ? words.filter(w => w.startSeconds >= start && w.endSeconds <= end)
          : undefined
      };
    }).filter(segment => segment.text.length > 0);
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

/**
 * Parse an array of Whisper-format word objects into TranscriptionWords.
 */
export function parseWhisperWords(
  words: RawWhisperWord[] | undefined,
  options: WhisperParseOptions = {}
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
      confidence: typeof word.confidence === 'number' ? word.confidence : undefined,
      speaker: options.extractSpeakers && typeof word.speaker === 'string'
        ? word.speaker
        : undefined
    }];
  });
}
