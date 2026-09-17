import { GoogleRealtimeVoiceSession } from '../../src/services/realtimeVoice/GoogleRealtimeVoiceSession';
import type { ResolvedGoogleRealtimeVoiceSessionRequest } from '../../src/services/realtimeVoice/RealtimeVoiceSessionTypes';

type TestableGoogleRealtimeVoiceSession = GoogleRealtimeVoiceSession & {
  handleServerMessage: (rawData: unknown) => Promise<void>;
  startAudioCapture: () => Promise<void>;
};

describe('GoogleRealtimeVoiceSession', () => {
  function createSession(
    callbacks: Partial<ResolvedGoogleRealtimeVoiceSessionRequest['callbacks']> = {},
    request: Partial<Omit<ResolvedGoogleRealtimeVoiceSessionRequest, 'callbacks' | 'provider'>> = {}
  ) {
    return new GoogleRealtimeVoiceSession({
      provider: 'google',
      model: 'gemini-3.8-live',
      voice: 'Kore',
      apiKey: 'test-key',
      ...request,
      callbacks: {
        onStateChange: jest.fn(),
        onError: jest.fn(),
        onUserTranscript: jest.fn(),
        onAssistantTranscriptDelta: jest.fn(),
        onAssistantTranscriptCompleted: jest.fn(),
        ...callbacks,
      },
    }) as TestableGoogleRealtimeVoiceSession;
  }

  it('buffers the user transcript until assistant output begins', async () => {
    const onUserTranscript = jest.fn();
    const onAssistantTranscriptDelta = jest.fn();
    const session = createSession({
      onUserTranscript,
      onAssistantTranscriptDelta,
    });

    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        inputTranscription: { text: 'Hello Nexus' },
      },
    }));

    expect(onUserTranscript).not.toHaveBeenCalled();

    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'Hi there' },
      },
    }));

    expect(onUserTranscript).toHaveBeenCalledWith('Hello Nexus');
    expect(onAssistantTranscriptDelta).toHaveBeenCalledWith('Hi there');
  });

  it('emits only the incremental assistant delta and completes on turnComplete', async () => {
    const onAssistantTranscriptDelta = jest.fn();
    const onAssistantTranscriptCompleted = jest.fn();
    const session = createSession({
      onAssistantTranscriptDelta,
      onAssistantTranscriptCompleted,
    });

    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'Hi' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'Hi there' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        turnComplete: true,
      },
    }));

    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(1, 'Hi');
    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(2, ' there');
    expect(onAssistantTranscriptCompleted).toHaveBeenCalledWith('Hi there');
  });

  it('accumulates non-cumulative assistant transcript fragments instead of replacing them', async () => {
    const onAssistantTranscriptDelta = jest.fn();
    const onAssistantTranscriptCompleted = jest.fn();
    const session = createSession({
      onAssistantTranscriptDelta,
      onAssistantTranscriptCompleted,
    });

    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'This' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'is' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'working' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        turnComplete: true,
      },
    }));

    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(1, 'This');
    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(2, ' is');
    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(3, ' working');
    expect(onAssistantTranscriptCompleted).toHaveBeenCalledWith('This is working');
  });

  describe('setup frame', () => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      static instances: FakeWebSocket[] = [];
      readonly readyState = FakeWebSocket.OPEN;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: ((event: { code: number; reason?: string }) => void) | null = null;
      constructor(public readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      send(data: string): void {
        this.sent.push(data);
      }
      close(): void {}
    }

    const originalWebSocket = globalThis.WebSocket;
    const originalAudioContext = globalThis.AudioContext;
    const originalNavigator = globalThis.navigator;

    beforeEach(() => {
      FakeWebSocket.instances = [];
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket });
      Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: jest.fn() });
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { mediaDevices: { getUserMedia: jest.fn() } },
      });
    });

    afterEach(() => {
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
      Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: originalAudioContext });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    });

    async function captureSetup(
      request: Partial<Omit<ResolvedGoogleRealtimeVoiceSessionRequest, 'callbacks' | 'provider'>>
    ): Promise<Record<string, unknown>> {
      const session = createSession({}, request);
      jest.spyOn(session, 'startAudioCapture').mockResolvedValue(undefined);
      const started = session.start();
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      socket.onopen?.();
      socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
      await started;
      return JSON.parse(socket.sent[0]).setup;
    }

    it('sends thinkingConfig only when the request carries a thinking effort', async () => {
      const extended = await captureSetup({
        model: 'gemini-3.8-live-extended-thinking',
        thinkingEffort: 'medium',
      });
      expect(extended.model).toBe('models/gemini-3.8-live-extended-thinking');
      expect(extended.generationConfig).toEqual(expect.objectContaining({
        responseModalities: ['AUDIO'],
        thinkingConfig: { thinkingLevel: 'medium' },
      }));

      const base = await captureSetup({ model: 'gemini-3.8-live' });
      expect(base.model).toBe('models/gemini-3.8-live');
      expect(base.generationConfig).not.toHaveProperty('thinkingConfig');
    });
  });

  it('accepts blob setup frames and transitions to listening', async () => {
    const onStateChange = jest.fn();
    const session = createSession({ onStateChange });
    jest.spyOn(session, 'startAudioCapture').mockResolvedValue(undefined);

    await session.handleServerMessage(new Blob([JSON.stringify({ setupComplete: {} })], {
      type: 'application/json',
    }));
    await Promise.resolve();

    expect(onStateChange).toHaveBeenCalledWith('listening');
  });
});