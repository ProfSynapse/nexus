import {
  buildSpeechProviderAvailability,
  getSpeechModel,
  getSpeechModelsForProvider,
  resolveDefaultSpeechSelection
} from '../../src/services/llm/types/SpeechTypes';
import {
  buildRealtimeVoiceProviderAvailability,
  getRealtimeVoiceModel,
  getRealtimeVoiceModelsForProvider,
  resolveDefaultRealtimeVoiceSelection
} from '../../src/services/llm/types/RealtimeVoiceTypes';
import {
  DEFAULT_LLM_PROVIDER_SETTINGS,
  type LLMProviderConfig,
  type LLMProviderSettings
} from '../../src/types/llm/ProviderTypes';

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

describe('SpeechTypes', () => {
  it('declares speech models separately from realtime models', () => {
    expect(getSpeechModel('openai', 'gpt-4o-mini-tts')).toEqual(expect.objectContaining({
      provider: 'openai',
      supportsInstructions: true
    }));
    expect(getSpeechModel('openai', 'gpt-4o-mini-tts')?.voices?.map(voice => voice.id)).toEqual(
      expect.arrayContaining(['fable', 'nova', 'onyx', 'marin', 'cedar'])
    );

    expect(getSpeechModel('openai', 'gpt-realtime-2')).toBeUndefined();
  });

  it('declares Google Gemini TTS voices separately from realtime voice', () => {
    expect(getSpeechModel('google', 'gemini-3.1-flash-tts-preview')).toEqual(expect.objectContaining({
      provider: 'google',
      defaultVoice: 'Kore',
      supportsInstructions: true,
      responseFormats: expect.arrayContaining(['wav', 'pcm'])
    }));
    expect(getSpeechModel('google', 'gemini-3.1-flash-tts-preview')?.voices?.map(voice => voice.id)).toEqual(
      expect.arrayContaining(['Kore', 'Puck', 'Zephyr', 'Sulafat'])
    );

    expect(getSpeechModel('google', 'gemini-3.1-flash-live-preview')).toBeUndefined();
  });

  it('auto-selects the highest-priority configured speech provider', () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        mistral: providerConfig(),
        openai: providerConfig()
      }
    });

    const selection = resolveDefaultSpeechSelection(settings);

    expect(selection).toEqual(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      source: 'auto',
      status: 'resolved'
    }));
  });

  it('lets enabled app-backed ElevenLabs speech outrank provider-backed speech in auto mode', () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig()
      }
    });
    const availability = buildSpeechProviderAvailability(settings, {
      elevenlabs: { enabled: true, configured: true }
    });

    const selection = resolveDefaultSpeechSelection(settings, availability);

    expect(selection).toEqual(expect.objectContaining({
      provider: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      source: 'auto',
      status: 'resolved'
    }));
  });

  it('does not silently replace a valid user-selected speech default', () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig(),
        mistral: providerConfig()
      },
      defaultSpeechModel: {
        provider: 'mistral',
        model: 'voxtral-mini-tts-2603',
        voice: 'saved-voice-id',
        source: 'user'
      }
    });

    const selection = resolveDefaultSpeechSelection(settings);

    expect(selection).toEqual(expect.objectContaining({
      provider: 'mistral',
      model: 'voxtral-mini-tts-2603',
      voice: 'saved-voice-id',
      source: 'user',
      status: 'resolved'
    }));
  });

  it('marks an unavailable user-selected speech default invalid instead of falling back', () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig(),
        mistral: providerConfig({ enabled: false })
      },
      defaultSpeechModel: {
        provider: 'mistral',
        model: 'voxtral-mini-tts-2603',
        source: 'user'
      }
    });

    const selection = resolveDefaultSpeechSelection(settings);

    expect(selection).toEqual(expect.objectContaining({
      provider: 'mistral',
      model: 'voxtral-mini-tts-2603',
      source: 'user',
      status: 'invalid'
    }));
  });

  it('filters disabled speech models from auto selection', () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig({
          models: {
            'gpt-4o-mini-tts': { enabled: false }
          }
        })
      }
    });

    const selection = resolveDefaultSpeechSelection(settings);

    expect(selection).toEqual(expect.objectContaining({
      provider: 'openai',
      model: 'tts-1',
      status: 'resolved'
    }));
  });

  it('returns unavailable when no speech provider is configured', () => {
    const selection = resolveDefaultSpeechSelection(DEFAULT_LLM_PROVIDER_SETTINGS);

    expect(selection).toEqual(expect.objectContaining({
      source: 'auto',
      status: 'unavailable'
    }));
  });

  it('keeps model declarations scoped by provider', () => {
    expect(getSpeechModelsForProvider('google').map(model => model.id)).toContain('gemini-3.1-flash-tts-preview');
    expect(getSpeechModelsForProvider('mistral').map(model => model.id)).toContain('voxtral-mini-tts-2603');
    expect(getSpeechModelsForProvider('openrouter').map(model => model.id)).toContain('mistralai/voxtral-mini-tts-2603');
    expect(getSpeechModelsForProvider('groq')).toEqual([]);
  });
});

describe('RealtimeVoiceTypes', () => {
  it('declares realtime models separately from speech models', () => {
    expect(getRealtimeVoiceModelsForProvider('openai').map(model => model.id)).toEqual(expect.arrayContaining([
      'gpt-realtime-2.1',
      'gpt-realtime-2.1-mini',
      'gpt-realtime-2'
    ]));
    expect(getRealtimeVoiceModelsForProvider('openrouter')).toEqual([]);
  });

  it('uses a Google-native default voice for Google live models', () => {
    const model = getRealtimeVoiceModel('google', 'gemini-3.1-flash-live-preview');

    expect(model).toEqual(expect.objectContaining({
      defaultVoice: 'Kore',
    }));
    expect(model?.voices?.some(voice => voice.id === 'Kore')).toBe(true);
  });

  it('auto-selects OpenAI before Google when both realtime providers are configured', () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig(),
        google: providerConfig()
      }
    });

    const selection = resolveDefaultRealtimeVoiceSelection(settings);

    expect(selection).toEqual(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-realtime-2.1',
      source: 'auto',
      status: 'resolved'
    }));
  });

  it('does not treat OpenRouter TTS as realtime voice', () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openrouter: providerConfig()
      }
    });

    const selection = resolveDefaultRealtimeVoiceSelection(settings);

    expect(selection).toEqual(expect.objectContaining({
      source: 'auto',
      status: 'unavailable'
    }));
  });

  it('keeps unwired ElevenLabs realtime hidden even when the app is enabled and configured', () => {
    const settings = makeSettings();
    const availability = buildRealtimeVoiceProviderAvailability(settings, {
      elevenlabs: { enabled: true, configured: true }
    });

    const selection = resolveDefaultRealtimeVoiceSelection(settings, availability);

    expect(selection).toEqual(expect.objectContaining({
      source: 'auto',
      status: 'unavailable'
    }));
    expect(availability.find(item => item.provider === 'elevenlabs')).toBeUndefined();
  });

  it('keeps invalid user-selected realtime defaults instead of falling back', () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig(),
        google: providerConfig({ enabled: false })
      },
      defaultRealtimeVoiceModel: {
        provider: 'google',
        model: 'gemini-3.1-flash-live-preview',
        source: 'user'
      }
    });

    const selection = resolveDefaultRealtimeVoiceSelection(settings);

    expect(selection).toEqual(expect.objectContaining({
      provider: 'google',
      model: 'gemini-3.1-flash-live-preview',
      source: 'user',
      status: 'invalid'
    }));
  });
});
