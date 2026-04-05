/**
 * VoiceTypes Unit Tests
 *
 * Tests the model catalog functions and default resolution logic:
 * - getTranscriptionModelsForProvider
 * - getTranscriptionModel
 * - getTranscriptionProviders
 * - resolveDefaultTranscriptionSelection
 */

import {
  getTranscriptionModelsForProvider,
  getTranscriptionModel,
  getTranscriptionProviders,
  resolveDefaultTranscriptionSelection,
  type TranscriptionProvider
} from '../../src/services/llm/types/VoiceTypes';
import { DEFAULT_LLM_PROVIDER_SETTINGS, type LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

describe('VoiceTypes', () => {
  // ── getTranscriptionModelsForProvider ────────────────────────────────

  describe('getTranscriptionModelsForProvider', () => {
    it('returns OpenAI models', () => {
      const models = getTranscriptionModelsForProvider('openai');
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('whisper-1');
      expect(models.every(m => m.provider === 'openai')).toBe(true);
    });

    it('returns Groq models', () => {
      const models = getTranscriptionModelsForProvider('groq');
      expect(models.length).toBeGreaterThanOrEqual(1);
      expect(models.every(m => m.provider === 'groq')).toBe(true);
    });

    it('returns empty array for unknown provider', () => {
      expect(getTranscriptionModelsForProvider('nonexistent')).toEqual([]);
    });

    it.each([
      'openai', 'groq', 'mistral', 'deepgram', 'assemblyai'
    ] as TranscriptionProvider[])('returns at least one model for %s', (provider) => {
      const models = getTranscriptionModelsForProvider(provider);
      expect(models.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── getTranscriptionModel ───────────────────────────────────────────

  describe('getTranscriptionModel', () => {
    it('finds whisper-1 for openai', () => {
      const model = getTranscriptionModel('openai', 'whisper-1');
      expect(model).toBeDefined();
      expect(model?.id).toBe('whisper-1');
      expect(model?.provider).toBe('openai');
    });

    it('returns undefined for wrong provider+model combo', () => {
      expect(getTranscriptionModel('groq', 'whisper-1')).toBeUndefined();
    });

    it('returns undefined for nonexistent model', () => {
      expect(getTranscriptionModel('openai', 'nonexistent')).toBeUndefined();
    });

    it('finds assemblyai universal-3-pro model', () => {
      const model = getTranscriptionModel('assemblyai', 'universal-3-pro');
      expect(model).toBeDefined();
      expect(model?.execution).toBe('speech-api-async');
    });

    it('returns undefined for removed google model', () => {
      expect(getTranscriptionModel('google', 'gemini-2.5-flash')).toBeUndefined();
    });
  });

  // ── getTranscriptionProviders ───────────────────────────────────────

  describe('getTranscriptionProviders', () => {
    it('returns all 5 providers', () => {
      const providers = getTranscriptionProviders();
      expect(providers).toContain('openai');
      expect(providers).toContain('groq');
      expect(providers).toContain('mistral');
      expect(providers).toContain('deepgram');
      expect(providers).toContain('assemblyai');
      expect(providers).toHaveLength(5);
    });

    it('returns no duplicates', () => {
      const providers = getTranscriptionProviders();
      expect(new Set(providers).size).toBe(providers.length);
    });
  });

  // ── resolveDefaultTranscriptionSelection ────────────────────────────

  describe('resolveDefaultTranscriptionSelection', () => {
    it('uses explicit provider+model when both are valid', () => {
      const result = resolveDefaultTranscriptionSelection(null, 'openai', 'whisper-1');
      expect(result).toEqual({ provider: 'openai', model: 'whisper-1' });
    });

    it('ignores explicit provider+model when model is invalid for that provider', () => {
      const result = resolveDefaultTranscriptionSelection(null, 'groq', 'whisper-1');
      // whisper-1 is not a groq model, falls through
      // No settings, only provider hint → picks first groq model
      expect(result.provider).toBe('groq');
      expect(result.model).toBeDefined();
    });

    it('uses settings default when no explicit provider/model', () => {
      const settings: LLMProviderSettings = {
        ...DEFAULT_LLM_PROVIDER_SETTINGS,
        defaultTranscriptionModel: {
          provider: 'groq',
          model: 'whisper-large-v3-turbo'
        }
      };
      const result = resolveDefaultTranscriptionSelection(settings);
      expect(result).toEqual({ provider: 'groq', model: 'whisper-large-v3-turbo' });
    });

    it('picks first model for provider when only provider is given', () => {
      const result = resolveDefaultTranscriptionSelection(null, 'deepgram');
      expect(result.provider).toBe('deepgram');
      expect(result.model).toBe('nova-3');
    });

    it('falls back to first enabled provider with API key', () => {
      const settings: LLMProviderSettings = {
        ...DEFAULT_LLM_PROVIDER_SETTINGS,
        providers: {
          ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
          groq: { apiKey: 'gsk-test', enabled: true }
        }
      };
      const result = resolveDefaultTranscriptionSelection(settings);
      expect(result.provider).toBe('groq');
      expect(result.model).toBeDefined();
    });

    it('returns empty object when no providers are enabled', () => {
      const result = resolveDefaultTranscriptionSelection(DEFAULT_LLM_PROVIDER_SETTINGS);
      expect(result).toEqual({});
    });

    it('returns empty object when settings are null and no explicit provider', () => {
      const result = resolveDefaultTranscriptionSelection(null);
      expect(result).toEqual({});
    });

    it('skips disabled providers in fallback', () => {
      const settings: LLMProviderSettings = {
        ...DEFAULT_LLM_PROVIDER_SETTINGS,
        providers: {
          ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
          openai: { apiKey: 'sk-test', enabled: false },
          groq: { apiKey: 'gsk-test', enabled: true }
        }
      };
      const result = resolveDefaultTranscriptionSelection(settings);
      expect(result.provider).toBe('groq');
    });

    it('skips providers with empty API key in fallback', () => {
      const settings: LLMProviderSettings = {
        ...DEFAULT_LLM_PROVIDER_SETTINGS,
        providers: {
          ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
          openai: { apiKey: '', enabled: true },
          groq: { apiKey: 'gsk-test', enabled: true }
        }
      };
      const result = resolveDefaultTranscriptionSelection(settings);
      expect(result.provider).toBe('groq');
    });
  });
});
