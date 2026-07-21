import { __setRequestUrlMock } from 'obsidian';
import { OpenRouterTranscriptionAdapter } from '../../src/services/llm/adapters/openrouter/OpenRouterTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest
} from '../../src/services/llm/types/VoiceTypes';

function makeChunk(overrides: Partial<AudioChunk> = {}): AudioChunk {
  return {
    data: new Uint8Array([1, 2, 3]).buffer,
    mimeType: 'audio/wav',
    startSeconds: 0,
    durationSeconds: 30,
    ...overrides
  };
}

function makeRequest(
  overrides: Partial<TranscriptionRequest & { provider: TranscriptionProvider; model: string }> = {}
): TranscriptionRequest & { provider: TranscriptionProvider; model: string } {
  return {
    audioData: new ArrayBuffer(3),
    mimeType: 'audio/wav',
    fileName: 'test.wav',
    provider: 'openrouter',
    model: 'mistralai/voxtral-mini-transcribe',
    ...overrides
  };
}

describe('OpenRouterTranscriptionAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends base64 audio to the OpenRouter transcription endpoint', async () => {
    let capturedRequest: { url?: string; headers?: Record<string, string>; body?: string | ArrayBuffer } = {};
    __setRequestUrlMock(async request => {
      capturedRequest = request;
      return {
        status: 200,
        json: { text: 'Hello from Voxtral.' }
      };
    });

    const adapter = new OpenRouterTranscriptionAdapter({
      apiKey: 'or-test-key',
      httpReferer: 'https://example.com',
      xTitle: 'Nexus test'
    });
    const result = await adapter.transcribeChunk(makeChunk(), makeRequest());

    expect(capturedRequest.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(capturedRequest.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer or-test-key',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://example.com',
      'X-Title': 'Nexus test'
    }));
    expect(JSON.parse(capturedRequest.body as string)).toEqual({
      model: 'mistralai/voxtral-mini-transcribe',
      input_audio: {
        data: 'AQID',
        format: 'wav'
      }
    });
    expect(result).toEqual([{
      startSeconds: 0,
      endSeconds: 30,
      text: 'Hello from Voxtral.',
      words: undefined
    }]);
  });

  it('rejects audio formats OpenRouter does not document', async () => {
    const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-test-key' });

    await expect(adapter.transcribeChunk(
      makeChunk({ mimeType: 'audio/x-ms-wma' }),
      makeRequest({ mimeType: 'audio/x-ms-wma', fileName: 'test.wma' })
    )).rejects.toThrow('does not support audio format');
  });

  it('throws a provider-specific error for non-200 responses', async () => {
    __setRequestUrlMock(async () => ({ status: 429, json: {} }));
    const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-test-key' });

    await expect(adapter.transcribeChunk(makeChunk(), makeRequest()))
      .rejects.toThrow('OpenRouter transcription failed: HTTP 429');
  });
});
