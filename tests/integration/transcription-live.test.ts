/**
 * Live integration tests for transcription adapters.
 *
 * These tests hit REAL APIs with REAL API keys.
 * Set environment variables before running:
 *
 *   OPENAI_API_KEY=sk-...
 *   GROQ_API_KEY=gsk_...
 *   DEEPGRAM_API_KEY=...
 *   ASSEMBLYAI_API_KEY=...
 *   MISTRAL_API_KEY=...
 *
 * Run:
 *   npx jest tests/integration/transcription-live.test.ts --no-coverage --verbose
 */

import * as fs from 'fs';
import { __setRequestUrlMock } from 'obsidian';
import { OpenAITranscriptionAdapter } from '../../src/services/llm/adapters/openai/OpenAITranscriptionAdapter';
import { GroqTranscriptionAdapter } from '../../src/services/llm/adapters/groq/GroqTranscriptionAdapter';
import { DeepgramTranscriptionAdapter } from '../../src/services/llm/adapters/deepgram/DeepgramTranscriptionAdapter';
import { AssemblyAITranscriptionAdapter } from '../../src/services/llm/adapters/assemblyai/AssemblyAITranscriptionAdapter';
import { MistralTranscriptionAdapter } from '../../src/services/llm/adapters/mistral/MistralTranscriptionAdapter';
import type { AudioChunk, TranscriptionRequest, TranscriptionProvider, TranscriptionSegment } from '../../src/services/llm/types/VoiceTypes';

// Wire requestUrl to real HTTP via fetch
beforeAll(() => {
  __setRequestUrlMock(async (request) => {
    const headers: Record<string, string> = {};
    if (request.headers) {
      for (const [k, v] of Object.entries(request.headers)) {
        headers[k] = String(v);
      }
    }

    const fetchOptions: RequestInit = {
      method: request.method || 'GET',
      headers,
    };

    if (request.body !== undefined && request.body !== null) {
      if (request.body instanceof ArrayBuffer) {
        fetchOptions.body = request.body;
      } else if (typeof request.body === 'string') {
        fetchOptions.body = request.body;
      } else {
        fetchOptions.body = request.body as BodyInit;
      }
    }

    const resp = await fetch(request.url, fetchOptions);
    const arrayBuf = await resp.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuf);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }

    return {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      text,
      json,
      arrayBuffer: arrayBuf,
    };
  });
});

// Load test audio file
const TEST_AUDIO_PATH = '/tmp/test-transcription.wav';
let testAudioData: ArrayBuffer;
let testChunk: AudioChunk;

beforeAll(() => {
  if (!fs.existsSync(TEST_AUDIO_PATH)) {
    throw new Error(
      `Test audio file not found at ${TEST_AUDIO_PATH}. ` +
      'Generate it with: say -o /tmp/test-transcription.aiff "Hello, this is a test." && ' +
      'afconvert -f WAVE -d LEI16 /tmp/test-transcription.aiff /tmp/test-transcription.wav'
    );
  }

  const buffer = fs.readFileSync(TEST_AUDIO_PATH);
  testAudioData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  testChunk = {
    data: testAudioData,
    mimeType: 'audio/wav',
    index: 0,
    durationSeconds: 5,
  };
});

function makeRequest(provider: TranscriptionProvider, model: string): TranscriptionRequest & { provider: TranscriptionProvider; model: string } {
  return {
    audioData: testAudioData,
    mimeType: 'audio/wav',
    fileName: 'test-transcription.wav',
    provider,
    model,
    requestWordTimestamps: true,
  };
}

function validateSegments(segments: TranscriptionSegment[], providerName: string): void {
  expect(segments.length).toBeGreaterThan(0);

  for (const segment of segments) {
    expect(typeof segment.startSeconds).toBe('number');
    expect(typeof segment.endSeconds).toBe('number');
    expect(typeof segment.text).toBe('string');
    expect(segment.text.length).toBeGreaterThan(0);
    expect(segment.endSeconds).toBeGreaterThanOrEqual(segment.startSeconds);
  }

  const fullText = segments.map(s => s.text).join(' ').toLowerCase();
  console.log(`[${providerName}] Transcribed: "${fullText}"`);

  // At least some of our test phrase should be recognized
  const expectedWords = ['hello', 'test', 'quick', 'brown', 'fox', 'lazy', 'dog'];
  const matchedWords = expectedWords.filter(w => fullText.includes(w));
  console.log(`[${providerName}] Matched ${matchedWords.length}/${expectedWords.length} expected words: ${matchedWords.join(', ')}`);
  expect(matchedWords.length).toBeGreaterThanOrEqual(3);
}

// --- API keys from environment ---

const openaiKey = process.env.OPENAI_API_KEY;
const groqKey = process.env.GROQ_API_KEY;
const deepgramKey = process.env.DEEPGRAM_API_KEY;
const assemblyaiKey = process.env.ASSEMBLYAI_API_KEY;
const mistralKey = process.env.MISTRAL_API_KEY;

// --- Speech-API providers (Whisper format) ---

describe('Live Transcription: OpenAI', () => {
  const runTest = openaiKey ? it : it.skip;

  runTest('transcribes with whisper-1', async () => {
    const adapter = new OpenAITranscriptionAdapter({ apiKey: openaiKey! });
    const segments = await adapter.transcribeChunk(testChunk, makeRequest('openai', 'whisper-1'));
    validateSegments(segments, 'OpenAI/whisper-1');
    const hasWords = segments.some(s => s.words && s.words.length > 0);
    console.log(`[OpenAI] Word timestamps: ${hasWords}`);
  }, 30_000);
});

describe('Live Transcription: Groq', () => {
  const runTest = groqKey ? it : it.skip;

  runTest('transcribes with whisper-large-v3-turbo', async () => {
    const adapter = new GroqTranscriptionAdapter({ apiKey: groqKey! });
    const segments = await adapter.transcribeChunk(testChunk, makeRequest('groq', 'whisper-large-v3-turbo'));
    validateSegments(segments, 'Groq/whisper-large-v3-turbo');
    const hasWords = segments.some(s => s.words && s.words.length > 0);
    console.log(`[Groq] Word timestamps: ${hasWords}`);
  }, 30_000);
});

describe('Live Transcription: Mistral', () => {
  const runTest = mistralKey ? it : it.skip;

  runTest('transcribes with voxtral-mini-latest', async () => {
    const adapter = new MistralTranscriptionAdapter({ apiKey: mistralKey! });
    const segments = await adapter.transcribeChunk(testChunk, makeRequest('mistral', 'voxtral-mini-latest'));
    validateSegments(segments, 'Mistral/voxtral-mini-latest');
    const hasWords = segments.some(s => s.words && s.words.length > 0);
    console.log(`[Mistral] Word timestamps: ${hasWords}`);
  }, 30_000);
});

// --- Deepgram (raw binary body) ---

describe('Live Transcription: Deepgram', () => {
  const runTest = deepgramKey ? it : it.skip;

  runTest('transcribes with nova-3', async () => {
    const adapter = new DeepgramTranscriptionAdapter({ apiKey: deepgramKey! });
    const segments = await adapter.transcribeChunk(testChunk, makeRequest('deepgram', 'nova-3'));
    validateSegments(segments, 'Deepgram/nova-3');
    const hasWords = segments.some(s => s.words && s.words.length > 0);
    console.log(`[Deepgram] Word timestamps: ${hasWords}`);
  }, 30_000);
});

// --- AssemblyAI (async upload + poll) ---

describe('Live Transcription: AssemblyAI', () => {
  const runTest = assemblyaiKey ? it : it.skip;

  runTest('transcribes with universal-3-pro model', async () => {
    const adapter = new AssemblyAITranscriptionAdapter({ apiKey: assemblyaiKey! });
    const segments = await adapter.transcribeChunk(testChunk, makeRequest('assemblyai', 'universal-3-pro'));
    validateSegments(segments, 'AssemblyAI/universal-3-pro');
    const hasWords = segments.some(s => s.words && s.words.length > 0);
    console.log(`[AssemblyAI] Word timestamps: ${hasWords}`);
  }, 120_000);
});

// --- Summary ---

const configuredProviders = [
  openaiKey && 'openai',
  groqKey && 'groq',
  mistralKey && 'mistral',
  deepgramKey && 'deepgram',
  assemblyaiKey && 'assemblyai',
].filter(Boolean) as string[];

describe('Provider summary', () => {
  it('lists configured providers', () => {
    console.log(`\nConfigured providers (${configuredProviders.length}/5): ${configuredProviders.join(', ')}`);
    const missing = ['openai', 'groq', 'mistral', 'deepgram', 'assemblyai']
      .filter(p => !configuredProviders.includes(p));
    if (missing.length > 0) {
      console.log(`Skipped (no API key): ${missing.join(', ')}`);
    }
    // All providers accounted for (configured + skipped = total)
    expect(configuredProviders.length + missing.length).toBe(5);
  });
});
