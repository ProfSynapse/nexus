/**
 * TranscriptionService Unit Tests
 *
 * Tests provider validation, API key checks, response parsing branches,
 * MIME-to-extension mapping, chunk timestamp offsetting, and error handling.
 */

// Mock AudioChunkingService
jest.mock(
  '../../src/agents/ingestManager/tools/services/AudioChunkingService',
  () => ({
    chunkAudio: jest.fn(),
  })
);

// Mock MultipartFormDataBuilder
jest.mock(
  '../../src/agents/ingestManager/tools/services/MultipartFormDataBuilder',
  () => ({
    buildMultipartFormData: jest.fn(),
  })
);

import { __setRequestUrlMock } from 'obsidian';
import {
  transcribeAudio,
  TranscriptionServiceDeps,
} from '../../src/agents/ingestManager/tools/services/TranscriptionService';
import { getIngestionProvidersForKind } from '../../src/agents/ingestManager/tools/services/IngestModelCatalog';
import { chunkAudio } from '../../src/agents/ingestManager/tools/services/AudioChunkingService';
import { buildMultipartFormData } from '../../src/agents/ingestManager/tools/services/MultipartFormDataBuilder';
import { AudioChunk } from '../../src/agents/ingestManager/types';

const chunkAudioMock = chunkAudio as jest.MockedFunction<typeof chunkAudio>;
const buildMultipartMock = buildMultipartFormData as jest.MockedFunction<typeof buildMultipartFormData>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<TranscriptionServiceDeps> = {}): TranscriptionServiceDeps {
  return {
    getApiKey: (provider: string) => (provider === 'openai' ? 'sk-test-key' : provider === 'groq' ? 'gsk-test-key' : undefined),
    ...overrides,
  };
}

function makeChunk(overrides: Partial<AudioChunk> = {}): AudioChunk {
  return {
    data: new ArrayBuffer(100),
    mimeType: 'audio/mpeg',
    startSeconds: 0,
    durationSeconds: 30,
    ...overrides,
  };
}

function setupSingleChunkDefaults() {
  chunkAudioMock.mockResolvedValue([makeChunk()]);
  buildMultipartMock.mockReturnValue({
    body: new ArrayBuffer(200),
    contentType: 'multipart/form-data; boundary=----test',
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TranscriptionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupSingleChunkDefaults();
  });

  // ── Provider validation ───────────────────────────────────────────────

  describe('provider validation', () => {
    it('throws for unsupported provider', async () => {
      // Provide a fake API key so we get past the key check to the provider/model check
      const deps = makeDeps({ getApiKey: () => 'fake-key' });
      await expect(
        transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'deepgram', undefined, deps)
      ).rejects.toThrow(/Provider "deepgram" does not support/);
    });

    it('error message includes provider name', async () => {
      const deps = makeDeps({ getApiKey: () => 'fake-key' });
      await expect(
        transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'unknown', undefined, deps)
      ).rejects.toThrow(/Provider "unknown"/);
    });

    it('accepts openai provider', async () => {
      __setRequestUrlMock(async () => ({ status: 200, json: { segments: [] } }));
      const result = await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', undefined, makeDeps());
      expect(result).toEqual([]);
    });

    it('accepts groq provider', async () => {
      __setRequestUrlMock(async () => ({ status: 200, json: { segments: [] } }));
      const result = await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'groq', undefined, makeDeps());
      expect(result).toEqual([]);
    });
  });

  // ── API key validation ────────────────────────────────────────────────

  describe('API key validation', () => {
    it('throws when API key is undefined', async () => {
      const deps = makeDeps({ getApiKey: () => undefined });
      await expect(
        transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', undefined, deps)
      ).rejects.toThrow(/No API key configured for provider "openai"/);
    });
  });

  // ── Default model selection ───────────────────────────────────────────

  describe('model selection', () => {
    it('uses gpt-4o-transcribe as default for openai', async () => {
      __setRequestUrlMock(async () => ({ status: 200, json: { text: '' } }));
      await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', undefined, makeDeps());
      expect(buildMultipartMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'model', value: 'gpt-4o-transcribe' }),
        ])
      );
    });

    it('uses whisper-large-v3-turbo as default for groq', async () => {
      __setRequestUrlMock(async () => ({ status: 200, json: { segments: [] } }));
      await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'groq', undefined, makeDeps());
      expect(buildMultipartMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'model', value: 'whisper-large-v3-turbo' }),
        ])
      );
    });

    it('uses explicit model when provided', async () => {
      __setRequestUrlMock(async () => ({ status: 200, json: { segments: [] } }));
      await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', 'whisper-1', makeDeps());
      expect(buildMultipartMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'model', value: 'whisper-1' }),
        ])
      );
    });
  });

  // ── Response parsing branches ─────────────────────────────────────────

  describe('response parsing', () => {
    it('parses verbose_json segments with timestamps', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          segments: [
            { start: 0, end: 5.2, text: '  Hello world  ' },
            { start: 5.2, end: 10.1, text: 'Second segment' },
          ],
        },
      }));
      // Use whisper-1 explicitly to get speech-api-segmented execution path
      const result = await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', 'whisper-1', makeDeps());
      expect(result).toEqual([
        { startSeconds: 0, endSeconds: 5.2, text: 'Hello world' },
        { startSeconds: 5.2, endSeconds: 10.1, text: 'Second segment' },
      ]);
    });

    it('falls back to full text when no segments array (segmented path)', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          text: '  Full transcript text  ',
          duration: 42.5,
        },
      }));
      // Use whisper-1 for speech-api-segmented — falls back to text+duration when no segments
      const result = await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', 'whisper-1', makeDeps());
      expect(result).toEqual([
        { startSeconds: 0, endSeconds: 42.5, text: 'Full transcript text' },
      ]);
    });

    it('uses chunk duration when text fallback has no response duration (segmented path)', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { text: 'No duration' },
      }));
      // Use whisper-1 for speech-api-segmented — falls back to chunk.durationSeconds when no response duration
      const result = await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', 'whisper-1', makeDeps());
      expect(result).toEqual([
        { startSeconds: 0, endSeconds: 30, text: 'No duration' },
      ]);
    });

    it('returns empty array when response has neither segments nor text', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {},
      }));
      const result = await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', undefined, makeDeps());
      expect(result).toEqual([]);
    });
  });

  // ── HTTP error handling ───────────────────────────────────────────────

  describe('error handling', () => {
    it('throws with status code on non-200 response', async () => {
      __setRequestUrlMock(async () => ({
        status: 401,
        text: 'Unauthorized: invalid API key',
        json: {},
      }));
      await expect(
        transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', undefined, makeDeps())
      ).rejects.toThrow(/Transcription failed: HTTP 401/);
    });

    it('does not include body text in error message', async () => {
      __setRequestUrlMock(async () => ({
        status: 500,
        text: 'Internal server error details',
        json: {},
      }));
      await expect(
        transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', undefined, makeDeps())
      ).rejects.toThrow(/Transcription failed: HTTP 500/);
      // Body text is logged to console.error but intentionally excluded from the thrown error
      await expect(
        transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', undefined, makeDeps())
      ).rejects.toThrow(expect.not.objectContaining({ message: expect.stringContaining('Internal server error') }));
    });

    it('handles non-string response.text gracefully', async () => {
      __setRequestUrlMock(async () => ({
        status: 400,
        text: 12345,
        json: {},
      }));
      await expect(
        transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', undefined, makeDeps())
      ).rejects.toThrow(/Transcription failed: HTTP 400/);
    });
  });

  // ── Chunk timestamp offsetting ────────────────────────────────────────

  describe('chunk timestamp offsetting', () => {
    it('offsets segment timestamps by chunk startSeconds', async () => {
      chunkAudioMock.mockResolvedValue([
        makeChunk({ startSeconds: 0, durationSeconds: 30 }),
        makeChunk({ startSeconds: 30, durationSeconds: 30 }),
      ]);

      let callCount = 0;
      __setRequestUrlMock(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 200,
            json: { segments: [{ start: 0, end: 10, text: 'Chunk 1' }] },
          };
        }
        return {
          status: 200,
          json: { segments: [{ start: 0, end: 8, text: 'Chunk 2' }] },
        };
      });

      // Use whisper-1 explicitly for speech-api-segmented (parses segments array)
      const result = await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', 'whisper-1', makeDeps());
      expect(result).toEqual([
        { startSeconds: 0, endSeconds: 10, text: 'Chunk 1' },
        { startSeconds: 30, endSeconds: 38, text: 'Chunk 2' },
      ]);
    });

    it('processes single chunk without offset', async () => {
      chunkAudioMock.mockResolvedValue([makeChunk({ startSeconds: 0 })]);
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { segments: [{ start: 2, end: 5, text: 'Mid-chunk' }] },
      }));

      // Use whisper-1 explicitly for speech-api-segmented
      const result = await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', 'whisper-1', makeDeps());
      expect(result).toEqual([
        { startSeconds: 2, endSeconds: 5, text: 'Mid-chunk' },
      ]);
    });
  });

  // ── Multipart form construction ───────────────────────────────────────

  describe('multipart form data', () => {
    it('passes correct fields for speech-api-segmented model', async () => {
      __setRequestUrlMock(async () => ({ status: 200, json: { segments: [] } }));
      await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', 'whisper-1', makeDeps());

      expect(buildMultipartMock).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'file', filename: 'test.mp3', contentType: 'audio/mpeg' }),
        expect.objectContaining({ name: 'model', value: 'whisper-1' }),
        expect.objectContaining({ name: 'response_format', value: 'verbose_json' }),
        expect.objectContaining({ name: 'timestamp_granularities[]', value: 'segment' }),
      ]);
    });

    it('derives filename extension from chunk mimeType', async () => {
      chunkAudioMock.mockResolvedValue([makeChunk({ mimeType: 'audio/wav' })]);
      __setRequestUrlMock(async () => ({ status: 200, json: { segments: [] } }));
      await transcribeAudio(new ArrayBuffer(10), 'audio/wav', 'recording.wav', 'openai', undefined, makeDeps());

      expect(buildMultipartMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'file', filename: 'recording.wav' }),
        ])
      );
    });

    it('uses .bin extension for unknown mimeType', async () => {
      chunkAudioMock.mockResolvedValue([makeChunk({ mimeType: 'audio/unknown-format' })]);
      __setRequestUrlMock(async () => ({ status: 200, json: { segments: [] } }));
      await transcribeAudio(new ArrayBuffer(10), 'audio/unknown-format', 'test.xyz', 'openai', undefined, makeDeps());

      expect(buildMultipartMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'file', filename: 'test.bin' }),
        ])
      );
    });
  });

  // ── HTTP request construction ─────────────────────────────────────────

  describe('HTTP request', () => {
    it('sends to OpenAI endpoint with Bearer auth', async () => {
      let capturedRequest: any = null;
      __setRequestUrlMock(async (req) => {
        capturedRequest = req;
        return { status: 200, json: { segments: [] } };
      });

      await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'openai', undefined, makeDeps());

      expect(capturedRequest.url).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect(capturedRequest.method).toBe('POST');
      expect(capturedRequest.headers['Authorization']).toBe('Bearer sk-test-key');
    });

    it('sends to Groq endpoint for groq provider', async () => {
      let capturedRequest: any = null;
      __setRequestUrlMock(async (req) => {
        capturedRequest = req;
        return { status: 200, json: { segments: [] } };
      });

      await transcribeAudio(new ArrayBuffer(10), 'audio/mpeg', 'test.mp3', 'groq', undefined, makeDeps());

      expect(capturedRequest.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      expect(capturedRequest.headers['Authorization']).toBe('Bearer gsk-test-key');
    });
  });

  // ── getIngestionProvidersForKind (transcription) ──────────────────────

  describe('getIngestionProvidersForKind (transcription)', () => {
    it('returns all transcription-capable providers', () => {
      const providers = getIngestionProvidersForKind('transcription');
      expect(providers).toContain('openai');
      expect(providers).toContain('groq');
      expect(providers).toContain('google');
      expect(providers).toContain('openrouter');
      expect(providers).toHaveLength(4);
    });
  });
});
