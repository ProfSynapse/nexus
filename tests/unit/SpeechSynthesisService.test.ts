import { requestUrl } from 'obsidian';
import { SpeechSynthesisService } from '../../src/services/readAloud/SpeechSynthesisService';
import {
  DEFAULT_LLM_PROVIDER_SETTINGS,
  type LLMProviderConfig,
  type LLMProviderSettings
} from '../../src/types/llm/ProviderTypes';

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}));

const requestUrlMock = requestUrl as jest.MockedFunction<typeof requestUrl>;

function providerConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    apiKey: 'test-key',
    enabled: true,
    ...overrides
  };
}

function makeSettings(overrides: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
  return {
    ...DEFAULT_LLM_PROVIDER_SETTINGS,
    providers: {
      ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
      ...overrides.providers
    },
    ...overrides
  };
}

describe('SpeechSynthesisService', () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it('resolves OpenAI speech defaults from Voice settings', () => {
    const service = new SpeechSynthesisService(makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig()
      },
      defaultSpeechModel: {
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
        voice: 'cedar',
        source: 'user'
      }
    }));

    expect(service.resolveRequest({ text: 'Read this.' })).toEqual({
      text: 'Read this.',
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'cedar'
    });
  });

  it('uses model default voice when no explicit voice is configured', () => {
    const service = new SpeechSynthesisService(makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig()
      },
      defaultSpeechModel: {
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
        source: 'user'
      }
    }));

    expect(service.resolveRequest({ text: 'Read this.' }).voice).toBe('marin');
  });

  it('resolves a provider-only request to the first available model for that provider', () => {
    const service = new SpeechSynthesisService(makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig()
      }
    }));

    expect(service.resolveRequest({
      text: 'Read this.',
      provider: 'openai'
    })).toEqual({
      text: 'Read this.',
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'marin'
    });
  });

  it('throws a clear error for explicit models without a provider', () => {
    const service = new SpeechSynthesisService(DEFAULT_LLM_PROVIDER_SETTINGS);

    expect(() => service.resolveRequest({
      text: 'Read this.',
      model: 'gpt-4o-mini-tts'
    })).toThrow('Speech provider is required when a model is specified.');
  });

  it('synthesizes Mistral speech through Voxtral TTS', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: '',
      json: {
        audio_data: globalThis.btoa('abc')
      },
    });

    const service = new SpeechSynthesisService(makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        mistral: providerConfig({ apiKey: 'mistral-key' })
      },
      defaultSpeechModel: {
        provider: 'mistral',
        model: 'voxtral-mini-tts-2603',
        voice: 'saved-voice-id',
        source: 'user'
      }
    }));

    const result = await service.synthesize({ text: 'Read this.' });

    expect(requestUrlMock).toHaveBeenCalledWith({
      url: 'https://api.mistral.ai/v1/audio/speech',
      method: 'POST',
      headers: {
        Authorization: 'Bearer mistral-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'voxtral-mini-tts-2603',
        input: 'Read this.',
        response_format: 'mp3',
        voice_id: 'saved-voice-id',
      }),
    });
    expect(result).toMatchObject({
      provider: 'mistral',
      model: 'voxtral-mini-tts-2603',
      voice: 'saved-voice-id',
      mimeType: 'audio/mpeg',
    });
    expect(result.audioData.byteLength).toBe(3);
  });

  it('synthesizes OpenRouter speech through the dedicated speech endpoint', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
      text: '',
      json: {},
    });

    const service = new SpeechSynthesisService(makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openrouter: providerConfig({ apiKey: 'openrouter-key' })
      },
      defaultSpeechModel: {
        provider: 'openrouter',
        model: 'mistralai/voxtral-mini-tts-2603',
        source: 'user'
      }
    }));

    const result = await service.synthesize({ text: 'Read this.' });

    expect(requestUrlMock).toHaveBeenCalledWith({
      url: 'https://openrouter.ai/api/v1/audio/speech',
      method: 'POST',
      headers: {
        Authorization: 'Bearer openrouter-key',
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        model: 'mistralai/voxtral-mini-tts-2603',
        input: 'Read this.',
        voice: 'alloy',
        response_format: 'mp3',
      }),
    });
    expect(result).toMatchObject({
      provider: 'openrouter',
      model: 'mistralai/voxtral-mini-tts-2603',
      voice: 'alloy',
      mimeType: 'audio/mpeg',
    });
  });

  it('synthesizes ElevenLabs speech with app credentials', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
      text: '',
      json: {},
    });

    const service = new SpeechSynthesisService(makeSettings({
      defaultSpeechModel: {
        provider: 'elevenlabs',
        model: 'eleven_multilingual_v2',
        source: 'user'
      }
    }), {
      appsSettings: {
        apps: {
          elevenlabs: {
            enabled: true,
            credentials: { apiKey: 'eleven-key' },
            installedAt: '2026-06-07T00:00:00.000Z',
            installedVersion: '1.0.0',
          }
        }
      }
    });

    const result = await service.synthesize({ text: 'Read this.' });

    expect(requestUrlMock).toHaveBeenCalledWith({
      url: 'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL',
      method: 'POST',
      headers: {
        'xi-api-key': 'eleven-key',
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: 'Read this.',
        model_id: 'eleven_multilingual_v2',
      }),
    });
    expect(result).toMatchObject({
      provider: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      voice: 'EXAVITQu4vr4xnSDxMaL',
      mimeType: 'audio/mpeg',
    });
  });

  it('throws when no speech provider is configured', () => {
    const service = new SpeechSynthesisService(DEFAULT_LLM_PROVIDER_SETTINGS);

    expect(() => service.resolveRequest({ text: 'Read this.' })).toThrow(
      'No speech provider/model available'
    );
  });
});
