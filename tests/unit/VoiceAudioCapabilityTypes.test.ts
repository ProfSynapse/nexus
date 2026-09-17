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
    expect(getSpeechModel('openrouter', 'deepgram/aura-2')).toEqual(expect.objectContaining({
      defaultVoice: 'aura-2-thalia-en',
      supportsDynamicVoices: true
    }));
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

  it('auto-selects Gemini 3.8 Live as the Google realtime default', () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig({ enabled: false }),
        google: providerConfig()
      }
    });

    const selection = resolveDefaultRealtimeVoiceSelection(settings);

    expect(selection).toEqual(expect.objectContaining({
      provider: 'google',
      model: 'gemini-3.8-live',
      source: 'auto',
      status: 'resolved'
    }));
  });

  it('declares a thinking floor only for Gemini 3.8 Live Extended Thinking', () => {
    // The base model closes the socket if thinkingConfig is present; the
    // extended model closes it if thinkingConfig is absent. The floor is how
    // the session tells them apart.
    expect(getRealtimeVoiceModel('google', 'gemini-3.8-live')?.thinkingLevelFloor).toBeUndefined();
    expect(getRealtimeVoiceModel('google', 'gemini-3.8-live-extended-thinking')).toEqual(expect.objectContaining({
      transport: 'websocket',
      execution: 'native-agent',
      defaultVoice: 'Kore',
      thinkingLevelFloor: 'low'
    }));
  });

  it('keeps Universal 3.5 Pro as the AssemblyAI realtime default ahead of the undocumented 3.6 ids', () => {
    const ids = getRealtimeVoiceModelsForProvider('assemblyai').map(model => model.id);
    expect(ids[0]).toBe('universal-3-5-pro');
    expect(ids).toEqual(expect.arrayContaining(['universal-3-6-pro', 'universal-3-6']));
    expect(ids).not.toContain('universal-3-7-preview');
    for (const id of ['universal-3-6-pro', 'universal-3-6']) {
      expect(getRealtimeVoiceModel('assemblyai', id)).toEqual(expect.objectContaining({
        transport: 'websocket',
        execution: 'transcription-pipeline'
      }));
    }
  });

  it('declares AssemblyAI Universal 3.5 as a composed realtime pipeline', () => {
    const model = getRealtimeVoiceModel('assemblyai', 'universal-3-5-pro');

    expect(model).toEqual(expect.objectContaining({
      execution: 'transcription-pipeline',
      supportsTools: true,
      supportsTranscripts: true,
    }));
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
