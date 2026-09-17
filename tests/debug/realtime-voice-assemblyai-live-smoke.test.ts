/**
 * AssemblyAI realtime transcription live smoke test.
 *
 * Drives the production path — RealtimeVoiceService.createSession() →
 * AssemblyAIRealtimeVoiceSession.start() — against the real v3 streaming API:
 * the temporary-token request goes through the plugin's `requestUrl` (bridged
 * to fetch here, as the provider smoke lane does) and the audio goes over a real
 * WebSocket. Only the microphone is faked: the test synthesizes a spoken phrase
 * with macOS `say`, hands it to the session's own capture callback in the same
 * 4096-sample frames a ScriptProcessorNode would, and waits for the session to
 * finalize a turn through onUserTranscript.
 *
 * Skipped unless explicitly enabled. Needs ASSEMBLYAI_API_KEY in the
 * environment or the repo-root .env, and macOS `say` on PATH.
 *
 *   RUN_REALTIME_VOICE_SMOKE=1 npx jest tests/debug/realtime-voice-assemblyai-live-smoke.test.ts --runInBand --no-coverage --verbose
 *
 * Pin one model (including an id not yet in the catalog, to vet it):
 *   REALTIME_VOICE_SMOKE_MODEL=universal-3-6-pro
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { __setRequestUrlMock } from 'obsidian';

import { RealtimeVoiceService } from '../../src/services/realtimeVoice/RealtimeVoiceService';
import { getRealtimeVoiceModelsForProvider } from '../../src/services/llm/types/RealtimeVoiceTypes';
import type { LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

jest.setTimeout(120_000);

const RUN_LIVE = process.env.RUN_REALTIME_VOICE_SMOKE === '1';
const PHRASE = 'The quick brown fox jumps over the lazy dog';
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 4096;

function readDotEnv(): Map<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const values = new Map<string, string>();
  if (!fs.existsSync(envPath)) {
    return values;
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      values.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
    }
  }
  return values;
}

const DOT_ENV = readDotEnv();

function getEnv(name: string): string | undefined {
  return process.env[name] || DOT_ENV.get(name);
}

function resolveTargets(): string[] {
  const pinned = getEnv('REALTIME_VOICE_SMOKE_MODEL');
  if (pinned) {
    return [pinned];
  }
  return getRealtimeVoiceModelsForProvider('assemblyai').map(model => model.id);
}

/** Route the plugin's requestUrl to real HTTP so the token request is the shipped one. */
function installRealRequestUrl(): void {
  __setRequestUrlMock(async (request) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      headers[key] = String(value);
    }
    const response = await fetch(request.url ?? '', {
      method: request.method || 'GET',
      headers,
      body: typeof request.body === 'string' ? request.body : undefined,
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    let json: unknown = {};
    try {
      json = JSON.parse(text);
    } catch {
      // Not every response is JSON.
    }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text, json, arrayBuffer };
  });
}

/** 16 kHz mono PCM16 of PHRASE from macOS `say`, decoded to float samples the way a capture node would hand them over. */
function synthesizePhrase(): Float32Array {
  const wavPath = path.join(os.tmpdir(), `nexus-aai-smoke-${process.pid}.wav`);
  execFileSync('say', ['-o', wavPath, `--data-format=LEI16@${SAMPLE_RATE}`, PHRASE]);
  const bytes = fs.readFileSync(wavPath);
  fs.unlinkSync(wavPath);

  // Minimal RIFF walk to the `data` chunk; `say` writes a canonical 44-byte header
  // but walking the chunks keeps this honest if it ever adds one.
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = bytes.readInt16LE(offset + 8 + i * 2) / 32768;
      }
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('No data chunk in synthesized WAV');
}

interface CaptureProcessor {
  onaudioprocess: ((event: { inputBuffer: { sampleRate: number; getChannelData(): Float32Array } }) => void) | null;
}

function installFakeAudio(): { processor: () => CaptureProcessor | null; restore: () => void } {
  let captured: CaptureProcessor | null = null;

  class FakeAudioContext {
    readonly destination = {};
    async resume(): Promise<void> {}
    async close(): Promise<void> {}
    createMediaStreamSource(): { connect(): void; disconnect(): void } {
      return { connect: () => {}, disconnect: () => {} };
    }
    createScriptProcessor(): CaptureProcessor & { connect(): void; disconnect(): void } {
      const processor = { onaudioprocess: null, connect: () => {}, disconnect: () => {} };
      captured = processor;
      return processor;
    }
    createGain(): { gain: { value: number }; connect(): void; disconnect(): void } {
      return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
    }
  }

  const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
  const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
  });

  return {
    processor: () => captured,
    restore: () => {
      Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: originalAudioContext });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    },
  };
}

function buildSettings(apiKey: string, model: string): LLMProviderSettings {
  return {
    providers: {
      openai: { enabled: false, apiKey: '' },
      google: { enabled: false, apiKey: '' },
      assemblyai: { enabled: true, apiKey },
    },
    defaultModel: { provider: 'openai', model: 'gpt-5.6-sol' },
    defaultRealtimeVoiceModel: { provider: 'assemblyai', model, source: 'user' },
  };
}

/** Feed samples at roughly real time in ScriptProcessor-sized frames, then enough silence to close the turn. */
async function pumpAudio(processor: CaptureProcessor, samples: Float32Array): Promise<void> {
  const silence = new Float32Array(SAMPLE_RATE * 2);
  const stream = new Float32Array(samples.length + silence.length);
  stream.set(samples);
  stream.set(silence, samples.length);

  const frameMs = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
  for (let start = 0; start < stream.length; start += FRAME_SAMPLES) {
    const frame = stream.subarray(start, Math.min(start + FRAME_SAMPLES, stream.length));
    processor.onaudioprocess?.({ inputBuffer: { sampleRate: SAMPLE_RATE, getChannelData: () => frame } });
    await new Promise(resolve => setTimeout(resolve, frameMs));
  }
}

const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive('AssemblyAI realtime transcription live smoke', () => {
  const apiKey = RUN_LIVE ? getEnv('ASSEMBLYAI_API_KEY') : undefined;
  const phrase = RUN_LIVE ? synthesizePhrase() : new Float32Array(0);

  beforeAll(() => {
    if (RUN_LIVE) {
      installRealRequestUrl();
    }
  });

  for (const model of resolveTargets()) {
    it(`${model} transcribes a spoken phrase through the shipped session`, async () => {
      if (!apiKey) {
        throw new Error('ASSEMBLYAI_API_KEY is required for the AssemblyAI realtime smoke test');
      }

      const audio = installFakeAudio();
      const states: string[] = [];
      const errors: string[] = [];
      const transcripts: string[] = [];
      let finalized: (() => void) | null = null;
      const turnDone = new Promise<void>(resolve => { finalized = resolve; });

      const service = new RealtimeVoiceService(buildSettings(apiKey, model));
      expect(service.getAvailability()).toEqual({ available: true });

      const session = service.createSession({
        callbacks: {
          onStateChange: state => { states.push(state); },
          onError: message => { errors.push(message); },
          onUserTranscript: text => {
            transcripts.push(text);
            finalized?.();
          },
        },
      });
      expect(session.mode).toBe('composed');

      try {
        await session.start();
        expect(errors).toEqual([]);
        expect(states).toEqual(['connecting', 'listening']);

        const processor = audio.processor();
        if (!processor) {
          throw new Error('Session never attached a capture processor');
        }

        const pumping = pumpAudio(processor, phrase);
        await Promise.race([
          turnDone,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
            `No finalized transcript within 45s (states=${states.join(',')} errors=${errors.join(' | ')})`
          )), 45_000)),
        ]);
        await pumping;

        expect(errors).toEqual([]);
        const heard = transcripts.join(' ').toLowerCase();
        expect(heard).toContain('quick brown fox');
        expect(states).toContain('user-speaking');

        console.log(`[realtime-voice-smoke] assemblyai ${model} → heard=${JSON.stringify(transcripts)}`);
      } finally {
        session.stop();
        audio.restore();
      }
    });
  }
});
