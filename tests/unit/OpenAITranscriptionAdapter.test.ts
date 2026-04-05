/**
 * OpenAITranscriptionAdapter Unit Tests
 *
 * Tests request construction, response parsing, and error handling for the
 * OpenAI Whisper API adapter. Representative of the multipart form-based
 * transcription adapters (Groq and Mistral follow the same pattern).
 */

jest.mock(
  '../../src/services/llm/utils/MultipartFormDataBuilder',
  () => ({
    buildMultipartFormData: jest.fn().mockReturnValue({
      body: new ArrayBuffer(100),
      contentType: 'multipart/form-data; boundary=----test'
    })
  })
);

import { __setRequestUrlMock } from 'obsidian';
import { OpenAITranscriptionAdapter } from '../../src/services/llm/adapters/openai/OpenAITranscriptionAdapter';
import { buildMultipartFormData } from '../../src/services/llm/utils/MultipartFormDataBuilder';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest
} from '../../src/services/llm/types/VoiceTypes';

const buildMultipartMock = buildMultipartFormData as jest.MockedFunction<typeof buildMultipartFormData>;

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
    provider: 'openai',
    model: 'whisper-1',
    ...overrides
  };
}

describe('OpenAITranscriptionAdapter', () => {
  let adapter: OpenAITranscriptionAdapter;

  beforeEach(() => {
    adapter = new OpenAITranscriptionAdapter({ apiKey: 'sk-test-key' });
    jest.clearAllMocks();
  });

  // ── Request construction ────────────────────────────────────────────

  describe('request construction', () => {
    beforeEach(() => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { segments: [] }
      }));
    });

    it('sends to OpenAI transcription endpoint', async () => {
      let capturedUrl = '';
      __setRequestUrlMock(async (req) => {
        capturedUrl = req.url || '';
        return { status: 200, json: { segments: [] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
    });

    it('includes Bearer auth header', async () => {
      let capturedHeaders: Record<string, string> = {};
      __setRequestUrlMock(async (req) => {
        capturedHeaders = (req.headers || {}) as Record<string, string>;
        return { status: 200, json: { segments: [] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedHeaders['Authorization']).toBe('Bearer sk-test-key');
    });

    it('builds multipart form with file, model, and verbose_json for whisper-1', async () => {
      await adapter.transcribeChunk(makeChunk(), makeRequest({ model: 'whisper-1' }));

      expect(buildMultipartMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'file' }),
          expect.objectContaining({ name: 'model', value: 'whisper-1' }),
          expect.objectContaining({ name: 'response_format', value: 'verbose_json' }),
          expect.objectContaining({ name: 'timestamp_granularities[]', value: 'segment' })
        ])
      );
    });

    it('adds word timestamp granularity when requested', async () => {
      await adapter.transcribeChunk(
        makeChunk(),
        makeRequest({ model: 'whisper-1', requestWordTimestamps: true })
      );

      const fields = buildMultipartMock.mock.calls[0][0];
      const timestampFields = fields.filter(f => f.name === 'timestamp_granularities[]');
      expect(timestampFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'segment' }),
          expect.objectContaining({ value: 'word' })
        ])
      );
    });

    it('includes prompt when provided', async () => {
      await adapter.transcribeChunk(
        makeChunk(),
        makeRequest({ prompt: '  Technical podcast  ' })
      );

      expect(buildMultipartMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'prompt', value: 'Technical podcast' })
        ])
      );
    });

    it('omits prompt when empty or whitespace', async () => {
      await adapter.transcribeChunk(makeChunk(), makeRequest({ prompt: '   ' }));

      const fields = buildMultipartMock.mock.calls[0][0];
      expect(fields.find(f => f.name === 'prompt')).toBeUndefined();
    });
  });

  // ── Response parsing: verbose_json segments ─────────────────────────

  describe('response parsing (segments)', () => {
    it('parses segments with timestamps', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          segments: [
            { start: 0, end: 5.2, text: '  Hello world  ' },
            { start: 5.2, end: 10.1, text: 'Second segment' }
          ]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([
        { startSeconds: 0, endSeconds: 5.2, text: 'Hello world', words: undefined },
        { startSeconds: 5.2, endSeconds: 10.1, text: 'Second segment', words: undefined }
      ]);
    });

    it('filters out empty-text segments', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          segments: [
            { start: 0, end: 5, text: 'Valid' },
            { start: 5, end: 10, text: '   ' },
            { start: 10, end: 15, text: '' }
          ]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('Valid');
    });

    it('defaults missing start to 0 and missing end to chunk duration', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          segments: [{ text: 'No timestamps' }]
        }
      }));

      const result = await adapter.transcribeChunk(
        makeChunk({ durationSeconds: 45 }),
        makeRequest()
      );
      expect(result[0].startSeconds).toBe(0);
      expect(result[0].endSeconds).toBe(45);
    });

    it('attaches words to matching segments', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          segments: [{ start: 0, end: 5, text: 'Hello world' }],
          words: [
            { word: 'Hello', start: 0, end: 2 },
            { word: 'world', start: 2.5, end: 4.5 }
          ]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].words).toEqual([
        { text: 'Hello', startSeconds: 0, endSeconds: 2 },
        { text: 'world', startSeconds: 2.5, endSeconds: 4.5 }
      ]);
    });
  });

  // ── Response parsing: plain text fallback ───────────────────────────

  describe('response parsing (text fallback)', () => {
    it('returns single segment from text field when no segments', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { text: '  Full transcript  ', duration: 42.5 }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([{
        startSeconds: 0,
        endSeconds: 42.5,
        text: 'Full transcript',
        words: undefined
      }]);
    });

    it('uses chunk duration when response has no duration', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { text: 'No duration' }
      }));

      const result = await adapter.transcribeChunk(
        makeChunk({ durationSeconds: 60 }),
        makeRequest()
      );
      expect(result[0].endSeconds).toBe(60);
    });

    it('returns empty array when text is empty', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { text: '   ' }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });

    it('returns empty array when response has no text or segments', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {}
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });
  });

  // ── Word parsing edge cases ─────────────────────────────────────────

  describe('word parsing', () => {
    it('ignores words with non-string word field', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          text: 'Hello',
          duration: 5,
          words: [
            { word: 123, start: 0, end: 1 },
            { word: 'Hello', start: 0, end: 2 }
          ]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].words).toEqual([
        { text: 'Hello', startSeconds: 0, endSeconds: 2 }
      ]);
    });

    it('ignores words with missing start or end', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          text: 'Hi',
          duration: 3,
          words: [
            { word: 'Hi', end: 1 },
            { word: 'There', start: 1 }
          ]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].words).toBeUndefined();
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws with HTTP status on non-200 response', async () => {
      __setRequestUrlMock(async () => ({
        status: 401,
        json: { error: { message: 'Invalid API key' } }
      }));

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('OpenAI transcription failed: HTTP 401');
    });

    it('throws with 500 status', async () => {
      __setRequestUrlMock(async () => ({
        status: 500,
        json: {}
      }));

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('OpenAI transcription failed: HTTP 500');
    });
  });
});
