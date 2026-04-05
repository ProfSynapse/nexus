/**
 * DeepgramTranscriptionAdapter Unit Tests
 *
 * Tests the raw binary body pattern: audio data sent directly with query
 * params, Token auth header, and nested response structure
 * (results.utterances / results.channels).
 */

import { __setRequestUrlMock } from 'obsidian';
import { DeepgramTranscriptionAdapter } from '../../src/services/llm/adapters/deepgram/DeepgramTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest
} from '../../src/services/llm/types/VoiceTypes';

function makeChunk(overrides: Partial<AudioChunk> = {}): AudioChunk {
  return {
    data: new ArrayBuffer(100),
    mimeType: 'audio/mpeg',
    startSeconds: 0,
    durationSeconds: 30,
    ...overrides
  };
}

function makeRequest(
  overrides: Partial<TranscriptionRequest & { provider: TranscriptionProvider; model: string }> = {}
): TranscriptionRequest & { provider: TranscriptionProvider; model: string } {
  return {
    audioData: new ArrayBuffer(100),
    mimeType: 'audio/mpeg',
    fileName: 'test.mp3',
    provider: 'deepgram',
    model: 'nova-3',
    ...overrides
  };
}

describe('DeepgramTranscriptionAdapter', () => {
  let adapter: DeepgramTranscriptionAdapter;

  beforeEach(() => {
    adapter = new DeepgramTranscriptionAdapter({ apiKey: 'dg-test-key' });
    jest.clearAllMocks();
  });

  // ── Request construction ────────────────────────────────────────────

  describe('request construction', () => {
    it('sends to Deepgram listen endpoint with query params', async () => {
      let capturedUrl = '';
      __setRequestUrlMock(async (req) => {
        capturedUrl = req.url || '';
        return { status: 200, json: { results: { channels: [{ alternatives: [{ transcript: 'Hi' }] }] } } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedUrl).toContain('https://api.deepgram.com/v1/listen');
      expect(capturedUrl).toContain('model=nova-3');
      expect(capturedUrl).toContain('smart_format=true');
      expect(capturedUrl).toContain('punctuate=true');
      expect(capturedUrl).toContain('utterances=true');
    });

    it('uses Token auth header (not Bearer)', async () => {
      let capturedHeaders: Record<string, string> = {};
      __setRequestUrlMock(async (req) => {
        capturedHeaders = (req.headers || {}) as Record<string, string>;
        return { status: 200, json: { results: { channels: [{ alternatives: [{ transcript: 'Hi' }] }] } } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedHeaders['Authorization']).toBe('Token dg-test-key');
    });

    it('sets Content-Type to chunk mimeType', async () => {
      let capturedHeaders: Record<string, string> = {};
      __setRequestUrlMock(async (req) => {
        capturedHeaders = (req.headers || {}) as Record<string, string>;
        return { status: 200, json: { results: { channels: [{ alternatives: [{ transcript: 'Hi' }] }] } } };
      });

      await adapter.transcribeChunk(makeChunk({ mimeType: 'audio/wav' }), makeRequest());
      expect(capturedHeaders['Content-Type']).toBe('audio/wav');
    });

    it('adds diarize param when speaker labels requested', async () => {
      let capturedUrl = '';
      __setRequestUrlMock(async (req) => {
        capturedUrl = req.url || '';
        return { status: 200, json: { results: { channels: [{ alternatives: [{ transcript: 'Hi' }] }] } } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest({ requestSpeakerLabels: true }));
      expect(capturedUrl).toContain('diarize=true');
    });

    it('does not add diarize param when not requested', async () => {
      let capturedUrl = '';
      __setRequestUrlMock(async (req) => {
        capturedUrl = req.url || '';
        return { status: 200, json: { results: { channels: [{ alternatives: [{ transcript: 'Hi' }] }] } } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedUrl).not.toContain('diarize');
    });
  });

  // ── Response parsing: utterances ────────────────────────────────────

  describe('response parsing (utterances)', () => {
    it('parses utterances with timestamps and speaker', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          results: {
            utterances: [{
              start: 0.5,
              end: 3.2,
              transcript: '  Hello world  ',
              confidence: 0.95,
              speaker: 0,
              words: [
                { punctuated_word: 'Hello', start: 0.5, end: 1.5, confidence: 0.97, speaker: 0 },
                { punctuated_word: 'world', start: 1.8, end: 3.2, confidence: 0.93, speaker: 0 }
              ]
            }]
          }
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([{
        startSeconds: 0.5,
        endSeconds: 3.2,
        text: 'Hello world',
        confidence: 0.95,
        speaker: '0',
        words: [
          { text: 'Hello', startSeconds: 0.5, endSeconds: 1.5, confidence: 0.97, speaker: '0' },
          { text: 'world', startSeconds: 1.8, endSeconds: 3.2, confidence: 0.93, speaker: '0' }
        ]
      }]);
    });

    it('converts numeric speaker to string', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          results: {
            utterances: [{
              start: 0, end: 5,
              transcript: 'Test',
              speaker: 2
            }]
          }
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].speaker).toBe('2');
    });

    it('prefers punctuated_word over word', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          results: {
            utterances: [{
              start: 0, end: 5,
              transcript: 'Test',
              words: [
                { word: 'test', punctuated_word: 'Test,', start: 0, end: 2 }
              ]
            }]
          }
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].words?.[0].text).toBe('Test,');
    });

    it('falls back to word when punctuated_word is missing', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          results: {
            utterances: [{
              start: 0, end: 5,
              transcript: 'Test',
              words: [
                { word: 'test', start: 0, end: 2 }
              ]
            }]
          }
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].words?.[0].text).toBe('test');
    });
  });

  // ── Response parsing: channels fallback ─────────────────────────────

  describe('response parsing (channels fallback)', () => {
    it('falls back to channels[0].alternatives[0]', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          results: {
            channels: [{
              alternatives: [{
                transcript: '  Channel text  ',
                confidence: 0.88,
                words: [
                  { word: 'Channel', start: 0, end: 1, confidence: 0.9 },
                  { word: 'text', start: 1.2, end: 2, confidence: 0.85 }
                ]
              }]
            }]
          }
        }
      }));

      const result = await adapter.transcribeChunk(
        makeChunk({ durationSeconds: 5 }),
        makeRequest()
      );
      expect(result).toEqual([{
        startSeconds: 0,
        endSeconds: 5,
        text: 'Channel text',
        confidence: 0.88,
        words: [
          { text: 'Channel', startSeconds: 0, endSeconds: 1, confidence: 0.9, speaker: undefined },
          { text: 'text', startSeconds: 1.2, endSeconds: 2, confidence: 0.85, speaker: undefined }
        ]
      }]);
    });

    it('returns empty array when channels has no alternatives', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { results: { channels: [{ alternatives: [] }] } }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });

    it('returns empty array when transcript is empty', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          results: {
            channels: [{ alternatives: [{ transcript: '   ' }] }]
          }
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });

    it('returns empty array when no results', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {}
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws with HTTP status on non-200', async () => {
      __setRequestUrlMock(async () => ({
        status: 401,
        json: {}
      }));

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('Deepgram transcription failed: HTTP 401');
    });
  });
});
