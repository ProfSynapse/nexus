import { SpeechSynthesisService } from '../../src/services/readAloud/SpeechSynthesisService';
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

describe('SpeechSynthesisService', () => {
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

  it('throws for configured speech providers not implemented in read-aloud V1', async () => {
    const service = new SpeechSynthesisService(makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        google: providerConfig()
      },
      defaultSpeechModel: {
        provider: 'google',
        model: 'gemini-2.5-flash-preview-tts',
        source: 'user'
      }
    }));

    await expect(service.synthesize({ text: 'Read this.' })).rejects.toThrow(
      'Speech provider "google" is not supported for read aloud yet.'
    );
  });

  it('throws when no speech provider is configured', () => {
    const service = new SpeechSynthesisService(DEFAULT_LLM_PROVIDER_SETTINGS);

    expect(() => service.resolveRequest({ text: 'Read this.' })).toThrow(
      'No speech provider/model available'
    );
  });
});
