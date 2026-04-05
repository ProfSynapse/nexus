/**
 * AssemblyAITranscriptionAdapter Unit Tests
 *
 * Tests the unique async polling pattern:
 * upload chunk → submit transcript → poll until completed → parse result.
 * Also covers speaker labels, word-level timestamps, and error conditions.
 */

import { __setRequestUrlMock } from 'obsidian';
import { AssemblyAITranscriptionAdapter } from '../../src/services/llm/adapters/assemblyai/AssemblyAITranscriptionAdapter';
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
    provider: 'assemblyai',
    model: 'universal-3-pro',
    ...overrides
  };
}

describe('AssemblyAITranscriptionAdapter', () => {
  let adapter: AssemblyAITranscriptionAdapter;
  const capturedRequests: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: unknown }> = [];

  beforeEach(() => {
    adapter = new AssemblyAITranscriptionAdapter({ apiKey: 'aai-test-key' });
    capturedRequests.length = 0;
    jest.clearAllMocks();
  });

  // Helper: sets up a happy-path mock for the full upload→submit→poll flow
  function setupHappyPath(transcriptResult: unknown) {
    let callCount = 0;
    __setRequestUrlMock(async (req) => {
      capturedRequests.push({
        url: req.url || '',
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.body
      });
      callCount++;

      // Call 1: upload
      if (callCount === 1) {
        return { status: 200, json: { upload_url: 'https://cdn.assemblyai.com/upload/abc123' } };
      }
      // Call 2: submit transcript
      if (callCount === 2) {
        return { status: 200, json: { id: 'transcript-456' } };
      }
      // Call 3: poll (completed immediately)
      return { status: 200, json: { status: 'completed', ...transcriptResult } };
    });
  }

  // ── Upload phase ────────────────────────────────────────────────────

  describe('upload phase', () => {
    it('uploads to AssemblyAI upload endpoint', async () => {
      setupHappyPath({ text: 'Hello', words: [] });
      await adapter.transcribeChunk(makeChunk(), makeRequest());

      expect(capturedRequests[0].url).toBe('https://api.assemblyai.com/v2/upload');
      expect(capturedRequests[0].method).toBe('POST');
    });

    it('sends API key as Authorization header (not Bearer)', async () => {
      setupHappyPath({ text: 'Hello', words: [] });
      await adapter.transcribeChunk(makeChunk(), makeRequest());

      expect(capturedRequests[0].headers?.['Authorization']).toBe('aai-test-key');
    });

    it('throws when upload returns non-200', async () => {
      __setRequestUrlMock(async () => ({ status: 500, json: {} }));

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('AssemblyAI upload failed: HTTP 500');
    });

    it('throws when upload does not return upload_url', async () => {
      __setRequestUrlMock(async () => ({ status: 200, json: {} }));

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('AssemblyAI upload did not return an upload URL');
    });
  });

  // ── Submit phase ────────────────────────────────────────────────────

  describe('submit phase', () => {
    it('submits transcript with audio URL and model', async () => {
      setupHappyPath({ text: 'Hello', words: [] });
      await adapter.transcribeChunk(makeChunk(), makeRequest());

      const submitBody = JSON.parse(capturedRequests[1].body as string);
      expect(submitBody.audio_url).toBe('https://cdn.assemblyai.com/upload/abc123');
      expect(submitBody.speech_models).toEqual(['universal-3-pro']);
    });

    it('sends prompt when provided', async () => {
      setupHappyPath({ text: 'Hello', words: [] });
      await adapter.transcribeChunk(makeChunk(), makeRequest({ prompt: '  Medical terms  ' }));

      const submitBody = JSON.parse(capturedRequests[1].body as string);
      expect(submitBody.prompt).toBe('Medical terms');
    });

    it('omits prompt when empty', async () => {
      setupHappyPath({ text: 'Hello', words: [] });
      await adapter.transcribeChunk(makeChunk(), makeRequest({ prompt: '   ' }));

      const submitBody = JSON.parse(capturedRequests[1].body as string);
      expect(submitBody.prompt).toBeUndefined();
    });

    it('enables speaker_labels when requested', async () => {
      setupHappyPath({ text: 'Hello', words: [] });
      await adapter.transcribeChunk(makeChunk(), makeRequest({ requestSpeakerLabels: true }));

      const submitBody = JSON.parse(capturedRequests[1].body as string);
      expect(submitBody.speaker_labels).toBe(true);
    });

    it('throws when submit returns error', async () => {
      let callCount = 0;
      __setRequestUrlMock(async () => {
        callCount++;
        if (callCount === 1) {
          return { status: 200, json: { upload_url: 'https://cdn.assemblyai.com/upload/abc' } };
        }
        return { status: 200, json: { error: 'Bad audio format' } };
      });

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('AssemblyAI transcript submission failed');
    });

    it('throws when submit returns non-200', async () => {
      let callCount = 0;
      __setRequestUrlMock(async () => {
        callCount++;
        if (callCount === 1) {
          return { status: 200, json: { upload_url: 'https://cdn.assemblyai.com/upload/abc' } };
        }
        return { status: 400, json: {} };
      });

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('AssemblyAI transcript submit failed: HTTP 400');
    });
  });

  // ── Polling phase ───────────────────────────────────────────────────

  describe('polling phase', () => {
    it('polls transcript endpoint with GET', async () => {
      setupHappyPath({ text: 'Done', words: [] });
      await adapter.transcribeChunk(makeChunk(), makeRequest());

      const pollReq = capturedRequests[2];
      expect(pollReq.url).toBe('https://api.assemblyai.com/v2/transcript/transcript-456');
      expect(pollReq.method).toBe('GET');
    });

    it('handles multiple poll iterations before completion', async () => {
      let callCount = 0;
      __setRequestUrlMock(async (req) => {
        capturedRequests.push({ url: req.url || '', method: req.method });
        callCount++;

        if (callCount === 1) return { status: 200, json: { upload_url: 'https://cdn.assemblyai.com/upload/abc' } };
        if (callCount === 2) return { status: 200, json: { id: 'tx-1' } };
        if (callCount === 3) return { status: 200, json: { status: 'queued' } };
        if (callCount === 4) return { status: 200, json: { status: 'processing' } };
        return { status: 200, json: { status: 'completed', text: 'Done', words: [] } };
      });

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedRequests).toHaveLength(5);
      expect(result[0].text).toBe('Done');
    });

    it('throws when transcript has error status', async () => {
      let callCount = 0;
      __setRequestUrlMock(async () => {
        callCount++;
        if (callCount === 1) return { status: 200, json: { upload_url: 'https://cdn.assemblyai.com/upload/abc' } };
        if (callCount === 2) return { status: 200, json: { id: 'tx-1' } };
        return { status: 200, json: { status: 'error', error: 'Audio too short' } };
      });

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('AssemblyAI transcription failed');
    });

    it('throws on poll HTTP error', async () => {
      let callCount = 0;
      __setRequestUrlMock(async () => {
        callCount++;
        if (callCount === 1) return { status: 200, json: { upload_url: 'https://cdn.assemblyai.com/upload/abc' } };
        if (callCount === 2) return { status: 200, json: { id: 'tx-1' } };
        return { status: 503, json: {} };
      });

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('AssemblyAI transcript poll failed: HTTP 503');
    });
  });

  // ── Response parsing: utterances ────────────────────────────────────

  describe('response parsing (utterances)', () => {
    it('parses utterances with speaker labels', async () => {
      setupHappyPath({
        text: 'Hello world',
        utterances: [
          {
            start: 500,
            end: 2500,
            text: 'Hello world',
            confidence: 0.95,
            speaker: 'A',
            words: [
              { text: 'Hello', start: 500, end: 1200, confidence: 0.97, speaker: 'A' },
              { text: 'world', start: 1300, end: 2500, confidence: 0.93, speaker: 'A' }
            ]
          }
        ]
      });

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([{
        startSeconds: 0.5,
        endSeconds: 2.5,
        text: 'Hello world',
        confidence: 0.95,
        speaker: 'A',
        words: [
          { text: 'Hello', startSeconds: 0.5, endSeconds: 1.2, confidence: 0.97, speaker: 'A' },
          { text: 'world', startSeconds: 1.3, endSeconds: 2.5, confidence: 0.93, speaker: 'A' }
        ]
      }]);
    });

    it('converts milliseconds to seconds', async () => {
      setupHappyPath({
        utterances: [{
          start: 1000,
          end: 3000,
          text: 'One to three seconds'
        }]
      });

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].startSeconds).toBe(1);
      expect(result[0].endSeconds).toBe(3);
    });

    it('filters out empty utterances', async () => {
      setupHappyPath({
        utterances: [
          { start: 0, end: 1000, text: 'Valid' },
          { start: 1000, end: 2000, text: '   ' }
        ]
      });

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toHaveLength(1);
    });
  });

  // ── Response parsing: text fallback ─────────────────────────────────

  describe('response parsing (text fallback)', () => {
    it('falls back to text+words when no utterances', async () => {
      setupHappyPath({
        text: '  Hello world  ',
        confidence: 0.92,
        words: [
          { text: 'Hello', start: 0, end: 500, confidence: 0.95 },
          { text: 'world', start: 600, end: 1200, confidence: 0.90 }
        ]
      });

      const result = await adapter.transcribeChunk(
        makeChunk({ durationSeconds: 5 }),
        makeRequest()
      );
      expect(result).toEqual([{
        startSeconds: 0,
        endSeconds: 5,
        text: 'Hello world',
        confidence: 0.92,
        words: [
          { text: 'Hello', startSeconds: 0, endSeconds: 0.5, confidence: 0.95, speaker: undefined },
          { text: 'world', startSeconds: 0.6, endSeconds: 1.2, confidence: 0.90, speaker: undefined }
        ]
      }]);
    });

    it('returns empty array when text is empty', async () => {
      setupHappyPath({ text: '   ' });

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });

    it('returns empty array when no text or utterances', async () => {
      setupHappyPath({});

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });
  });

  // ── Word parsing edge cases ─────────────────────────────────────────

  describe('word parsing', () => {
    it('ignores words with non-string text', async () => {
      setupHappyPath({
        text: 'Test',
        words: [
          { text: 123, start: 0, end: 500 },
          { text: 'Test', start: 0, end: 500, confidence: 0.9 }
        ]
      });

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].words).toHaveLength(1);
    });

    it('ignores words with missing timestamps', async () => {
      setupHappyPath({
        text: 'Test',
        words: [{ text: 'Test' }]
      });

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].words).toBeUndefined();
    });
  });
});
