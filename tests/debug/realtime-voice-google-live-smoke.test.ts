/**
 * Google realtime voice live smoke test.
 *
 * Drives the production path — RealtimeVoiceService.createSession() →
 * GoogleRealtimeVoiceSession.start() — against the real Gemini Live API over a
 * real WebSocket. Only the microphone and speaker are faked: getUserMedia and
 * AudioContext are stand-ins that record what the session does with them. The
 * user turn is injected as text through the session's own sendMessage, since a
 * headless run has no speech to capture; everything downstream (setup frame,
 * server message handling, transcript callbacks, PCM decode, state machine,
 * turn completion) is the shipped code.
 *
 * Skipped unless explicitly enabled. Reads GEMINI_API_KEY from the environment
 * or the .env in the current working directory (run from the repo root).
 *
 *   RUN_REALTIME_VOICE_SMOKE=1 npx jest tests/debug/realtime-voice-google-live-smoke.test.ts --runInBand --no-coverage --verbose
 *
 * Pin one model / thinking setting:
 *   REALTIME_VOICE_SMOKE_MODEL=gemini-3.8-live-extended-thinking
 *   REALTIME_VOICE_SMOKE_THINKING=high      (low | medium | high | off)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { RealtimeVoiceService } from '../../src/services/realtimeVoice/RealtimeVoiceService';
import { getRealtimeVoiceModelsForProvider } from '../../src/services/llm/types/RealtimeVoiceTypes';
import type { LLMProviderSettings, ThinkingEffort } from '../../src/types/llm/ProviderTypes';

jest.setTimeout(120_000);

const RUN_LIVE = process.env.RUN_REALTIME_VOICE_SMOKE === '1';

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

interface SmokeTarget {
  model: string;
  thinking: ThinkingEffort | 'off';
}

function resolveTargets(): SmokeTarget[] {
  const pinnedModel = getEnv('REALTIME_VOICE_SMOKE_MODEL');
  const pinnedThinking = getEnv('REALTIME_VOICE_SMOKE_THINKING') as SmokeTarget['thinking'] | undefined;
  if (pinnedModel) {
    return [{ model: pinnedModel, thinking: pinnedThinking ?? 'off' }];
  }

  // Every Google model in the catalog, once with thinking off and — for models
  // that declare a floor — once per level, so each translation is exercised.
  return getRealtimeVoiceModelsForProvider('google').flatMap((declaration): SmokeTarget[] => {
    const base: SmokeTarget[] = [{ model: declaration.id, thinking: 'off' }];
    if (!declaration.thinkingLevelFloor) {
      return base;
    }
    return [...base, ...(['low', 'medium', 'high'] as const).map(thinking => ({ model: declaration.id, thinking }))];
  });
}

/**
 * Minimal Web Audio stand-in covering exactly the surface the session touches.
 * It records decoded playback buffers so the test can prove audio came back
 * and was decoded, without ever making a sound.
 */
interface FakeAudioTrace {
  contexts: number;
  playbackBuffers: number;
  playbackSamples: number;
  processorAttached: boolean;
}

function installFakeAudio(): { trace: FakeAudioTrace; restore: () => void } {
  const trace: FakeAudioTrace = { contexts: 0, playbackBuffers: 0, playbackSamples: 0, processorAttached: false };

  class FakeAudioBufferSourceNode {
    buffer: { duration: number } | null = null;
    onended: (() => void) | null = null;
    connect(): void {}
    start(): void {
      // Fire onended on the next tick so the session's queue drains and it can
      // transition back to 'listening' the way a real playback would.
      setTimeout(() => this.onended?.(), 0);
    }
    stop(): void {}
  }

  class FakeAudioContext {
    readonly destination = {};
    currentTime = 0;
    constructor() {
      trace.contexts += 1;
    }
    async resume(): Promise<void> {}
    async close(): Promise<void> {}
    createMediaStreamSource(): { connect(): void; disconnect(): void } {
      return { connect: () => {}, disconnect: () => {} };
    }
    createScriptProcessor(): { connect(): void; disconnect(): void; onaudioprocess: unknown } {
      trace.processorAttached = true;
      return { connect: () => {}, disconnect: () => {}, onaudioprocess: null };
    }
    createGain(): { gain: { value: number }; connect(): void; disconnect(): void } {
      return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
    }
    createBuffer(_channels: number, length: number, sampleRate: number): { duration: number; copyToChannel(): void } {
      trace.playbackBuffers += 1;
      trace.playbackSamples += length;
      return { duration: length / sampleRate, copyToChannel: () => {} };
    }
    createBufferSource(): FakeAudioBufferSourceNode {
      return new FakeAudioBufferSourceNode();
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
    trace,
    restore: () => {
      Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: originalAudioContext });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    },
  };
}

function buildSettings(apiKey: string, target: SmokeTarget): LLMProviderSettings {
  return {
    providers: {
      openai: { enabled: false, apiKey: '' },
      google: { enabled: true, apiKey },
    },
    defaultModel: { provider: 'google', model: 'gemini-3.1-pro-preview' },
    defaultRealtimeVoiceModel: {
      provider: 'google',
      model: target.model,
      source: 'user',
    },
    defaultThinking: target.thinking === 'off'
      ? { enabled: false, effort: 'medium' }
      : { enabled: true, effort: target.thinking },
  };
}

type SessionWithInternals = {
  sendMessage: (payload: Record<string, unknown>) => void;
};

const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive('Google realtime voice live smoke', () => {
  const apiKey = RUN_LIVE ? getEnv('GEMINI_API_KEY') : undefined;

  for (const target of resolveTargets()) {
    it(`${target.model} (thinking=${target.thinking}) completes a spoken turn through the shipped session`, async () => {
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY is required for the Google realtime voice smoke test');
      }

      const audio = installFakeAudio();
      const states: string[] = [];
      const errors: string[] = [];
      let completedTranscript = '';
      let deltaCount = 0;
      let turnCompleted: (() => void) | null = null;
      const turnDone = new Promise<void>(resolve => { turnCompleted = resolve; });

      const service = new RealtimeVoiceService(buildSettings(apiKey, target));
      expect(service.getAvailability()).toEqual({ available: true });

      const session = service.createSession({
        instructions: 'You are a voice assistant. Answer in one short sentence.',
        callbacks: {
          onStateChange: state => { states.push(state); },
          onError: message => { errors.push(message); },
          onAssistantTranscriptDelta: () => { deltaCount += 1; },
          onAssistantTranscriptCompleted: text => {
            completedTranscript = text;
            turnCompleted?.();
          },
        },
      });

      try {
        await session.start();
        expect(errors).toEqual([]);
        expect(states[0]).toBe('connecting');

        // start() resolves on setupComplete; 'listening' follows once audio
        // capture is up, so give the session a moment rather than asserting
        // the two land in the same tick.
        for (let i = 0; i < 50 && !states.includes('listening'); i += 1) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(errors).toEqual([]);
        expect(states).toEqual(['connecting', 'listening']);
        expect(audio.trace.processorAttached).toBe(true);

        // Headless: no microphone, so the user turn goes in as text through the
        // session's own outbound path. Google answers it with audio + transcript
        // exactly as it would a spoken turn.
        (session as unknown as SessionWithInternals).sendMessage({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: 'Say hello and tell me which model you are, in one sentence.' }] }],
            turnComplete: true,
          },
        });

        await Promise.race([
          turnDone,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
            `No completed assistant transcript within 60s (states=${states.join(',')} deltas=${deltaCount} errors=${errors.join(' | ')})`
          )), 60_000)),
        ]);

        expect(errors).toEqual([]);
        expect(completedTranscript.trim().length).toBeGreaterThan(0);
        expect(deltaCount).toBeGreaterThan(0);
        expect(states).toContain('assistant-speaking');
        expect(audio.trace.playbackBuffers).toBeGreaterThan(0);
        expect(audio.trace.playbackSamples).toBeGreaterThan(0);

        console.log(
          `[realtime-voice-smoke] ${target.model} thinking=${target.thinking} → ` +
          `${audio.trace.playbackBuffers} audio chunks / ${audio.trace.playbackSamples} samples, ` +
          `transcript=${JSON.stringify(completedTranscript.trim())}`
        );
      } finally {
        session.stop();
        audio.restore();
      }
    });
  }
});
