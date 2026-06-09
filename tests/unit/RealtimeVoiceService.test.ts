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
});
