import { RealtimeVoiceService } from '../../src/services/realtimeVoice/RealtimeVoiceService';
import type { LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

describe('RealtimeVoiceService', () => {
  const originalRTCPeerConnection = globalThis.RTCPeerConnection;
  const originalNavigator = globalThis.navigator;
  const originalWebSocket = globalThis.WebSocket;
  const originalAudioContext = globalThis.AudioContext;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      configurable: true,
      value: jest.fn(),
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: jest.fn(),
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: jest.fn(),
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: jest.fn(),
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      configurable: true,
      value: originalRTCPeerConnection,
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: originalWebSocket,
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: originalAudioContext,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  });

  function buildSettings(overrides: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
    return {
      providers: {
        openai: {
          enabled: true,
          apiKey: 'openai-key',
        },
        google: {
          enabled: false,
          apiKey: '',
        },
      },
      defaultModel: {
        provider: 'openai',
        model: 'gpt-4o',
      },
      defaultRealtimeVoiceModel: {
        provider: 'openai',
        model: 'gpt-realtime-2',
        voice: 'marin',
        source: 'user',
      },
      ...overrides,
    };
  }

  it('is available when OpenAI realtime voice is configured and browser APIs exist', () => {
    const service = new RealtimeVoiceService(buildSettings());

    expect(service.getAvailability()).toEqual({ available: true });
  });

  it('reports when no realtime provider is configured', () => {
    const service = new RealtimeVoiceService(null);

    expect(service.getAvailability()).toEqual({
      available: false,
      reason: 'No realtime voice provider/model is configured.',
    });
  });

  it('is available when Google live voice is configured and browser APIs exist', () => {
    const service = new RealtimeVoiceService(buildSettings({
      providers: {
        openai: {
          enabled: false,
          apiKey: '',
        },
        google: {
          enabled: true,
          apiKey: 'google-key',
        },
      },
      defaultRealtimeVoiceModel: {
        provider: 'google',
        model: 'gemini-3.1-flash-live-preview',
        source: 'user',
      },
    }));

    expect(service.getAvailability()).toEqual({
      available: true,
    });
  });

  it('is available when AssemblyAI realtime transcription is configured', () => {
    const service = new RealtimeVoiceService(buildSettings({
      providers: {
        openai: {
          enabled: false,
          apiKey: '',
        },
        google: {
          enabled: false,
          apiKey: '',
        },
        assemblyai: {
          enabled: true,
          apiKey: 'assemblyai-key',
        },
      },
      defaultRealtimeVoiceModel: {
        provider: 'assemblyai',
        model: 'universal-3-5-pro',
        source: 'user',
      },
    }));

    expect(service.getAvailability()).toEqual({ available: true });
    expect(service.createSession({
      callbacks: {
        onStateChange: jest.fn(),
        onError: jest.fn(),
      },
    }).mode).toBe('composed');
  });

  describe('Google thinking effort translation', () => {
    function googleSettings(model: string, overrides: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
      return buildSettings({
        providers: {
          openai: { enabled: false, apiKey: '' },
          google: { enabled: true, apiKey: 'google-key' },
        },
        defaultRealtimeVoiceModel: { provider: 'google', model, source: 'user' },
        ...overrides,
      });
    }

    function resolvedThinkingEffort(settings: LLMProviderSettings): string | undefined {
      const session = new RealtimeVoiceService(settings).createSession({
        callbacks: { onStateChange: jest.fn(), onError: jest.fn() },
      }) as unknown as { request: { thinkingEffort?: string } };
      return session.request.thinkingEffort;
    }

    it('carries the app-wide thinking effort to a model that requires a level', () => {
      expect(resolvedThinkingEffort(googleSettings('gemini-3.8-live-extended-thinking', {
        defaultThinking: { enabled: true, effort: 'high' },
      }))).toBe('high');
    });

    it('falls back to the model floor when thinking is off', () => {
      expect(resolvedThinkingEffort(googleSettings('gemini-3.8-live-extended-thinking', {
        defaultThinking: { enabled: false, effort: 'high' },
      }))).toBe('low');
    });

    it('sends no thinking level to models that reject one', () => {
      expect(resolvedThinkingEffort(googleSettings('gemini-3.8-live', {
        defaultThinking: { enabled: true, effort: 'high' },
      }))).toBeUndefined();
    });
  });
});
