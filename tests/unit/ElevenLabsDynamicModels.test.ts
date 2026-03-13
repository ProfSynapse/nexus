/**
 * ElevenLabsDynamicModels.test.ts — Tests for dynamic ElevenLabs model selection.
 *
 * Covers:
 * - ElevenLabsAgent.fetchTTSModels() — API call, filtering, error handling
 * - ElevenLabsAgent.getDefaultModelId() — settings fallback
 * - BaseAppAgent settings getter/setter
 * - AppManager.setAppSettings() persistence
 * - TextToSpeechTool default model resolution
 */

import { requestUrl } from 'obsidian';
import { ElevenLabsAgent } from '../../src/agents/apps/elevenlabs/ElevenLabsAgent';
import { AppManager } from '../../src/services/apps/AppManager';
import { ElevenLabsModel, AppsSettings } from '../../src/types/apps/AppTypes';

const mockRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

// Sample model data matching ElevenLabs API response shape
const SAMPLE_MODELS: ElevenLabsModel[] = [
  {
    model_id: 'eleven_multilingual_v2',
    name: 'Eleven Multilingual v2',
    can_do_text_to_speech: true,
    can_do_voice_conversion: false,
    requires_alpha_access: false,
    description: 'Multilingual TTS model',
    token_cost_factor: 1.0,
    languages: [{ language_id: 'en', name: 'English' }],
  },
  {
    model_id: 'eleven_turbo_v2_5',
    name: 'Eleven Turbo v2.5',
    can_do_text_to_speech: true,
    can_do_voice_conversion: false,
    requires_alpha_access: false,
    description: 'Fastest TTS model',
    token_cost_factor: 0.5,
    languages: [{ language_id: 'en', name: 'English' }],
  },
  {
    model_id: 'eleven_voice_conversion_v1',
    name: 'Voice Conversion v1',
    can_do_text_to_speech: false,
    can_do_voice_conversion: true,
    requires_alpha_access: false,
    description: 'Voice conversion only',
    token_cost_factor: 1.0,
    languages: [],
  },
  {
    model_id: 'eleven_alpha_model',
    name: 'Alpha Access Model',
    can_do_text_to_speech: true,
    can_do_voice_conversion: false,
    requires_alpha_access: true,
    description: 'Requires alpha access',
    token_cost_factor: 2.0,
    languages: [],
  },
];

describe('ElevenLabsAgent', () => {
  let agent: ElevenLabsAgent;

  beforeEach(() => {
    agent = new ElevenLabsAgent();
    agent.setCredentials({ apiKey: 'test-api-key' });
    mockRequestUrl.mockReset();
  });

  describe('fetchTTSModels', () => {
    it('should fetch and filter TTS-capable models', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        json: SAMPLE_MODELS,
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
      } as never);

      const result = await agent.fetchTTSModels();

      expect(result.success).toBe(true);
      expect(result.models).toHaveLength(2);
      expect(result.models![0].model_id).toBe('eleven_multilingual_v2');
      expect(result.models![1].model_id).toBe('eleven_turbo_v2_5');
    });

    it('should exclude models requiring alpha access', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        json: SAMPLE_MODELS,
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
      } as never);

      const result = await agent.fetchTTSModels();

      const alphaModel = result.models?.find(m => m.model_id === 'eleven_alpha_model');
      expect(alphaModel).toBeUndefined();
    });

    it('should exclude non-TTS models', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        json: SAMPLE_MODELS,
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
      } as never);

      const result = await agent.fetchTTSModels();

      const vcModel = result.models?.find(m => m.model_id === 'eleven_voice_conversion_v1');
      expect(vcModel).toBeUndefined();
    });

    it('should call the correct API endpoint with API key header', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        json: [],
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
      } as never);

      await agent.fetchTTSModels();

      expect(mockRequestUrl).toHaveBeenCalledWith({
        url: 'https://api.elevenlabs.io/v1/models',
        method: 'GET',
        headers: { 'xi-api-key': 'test-api-key' },
      });
    });

    it('should return error when API key is not configured', async () => {
      agent.setCredentials({});

      const result = await agent.fetchTTSModels();

      expect(result.success).toBe(false);
      expect(result.error).toBe('API key not configured');
      expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('should handle API errors gracefully', async () => {
      mockRequestUrl.mockRejectedValueOnce({ status: 401 });

      const result = await agent.fetchTTSModels();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to fetch models');
      expect(result.error).toContain('401');
    });

    it('should handle network errors without status', async () => {
      mockRequestUrl.mockRejectedValueOnce(new Error('Network error'));

      const result = await agent.fetchTTSModels();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to fetch models');
    });

    it('should handle empty response', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        json: [],
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
      } as never);

      const result = await agent.fetchTTSModels();

      expect(result.success).toBe(true);
      expect(result.models).toHaveLength(0);
    });
  });

  describe('getDefaultModelId', () => {
    it('should return eleven_multilingual_v2 when no setting is configured', () => {
      expect(agent.getDefaultModelId()).toBe('eleven_multilingual_v2');
    });

    it('should return the user-selected model when configured', () => {
      agent.setSettings({ defaultTTSModel: 'eleven_turbo_v2_5' });

      expect(agent.getDefaultModelId()).toBe('eleven_turbo_v2_5');
    });

    it('should fall back to default when setting is empty string', () => {
      agent.setSettings({ defaultTTSModel: '' });

      expect(agent.getDefaultModelId()).toBe('eleven_multilingual_v2');
    });
  });
});

describe('BaseAppAgent settings', () => {
  let agent: ElevenLabsAgent;

  beforeEach(() => {
    agent = new ElevenLabsAgent();
  });

  it('should store and retrieve settings', () => {
    agent.setSettings({ defaultTTSModel: 'eleven_turbo_v2_5', otherSetting: 'value' });

    expect(agent.getSetting('defaultTTSModel')).toBe('eleven_turbo_v2_5');
    expect(agent.getSetting('otherSetting')).toBe('value');
  });

  it('should return undefined for non-existent setting', () => {
    expect(agent.getSetting('nonExistent')).toBeUndefined();
  });

  it('should return a copy of all settings', () => {
    agent.setSettings({ key1: 'val1', key2: 'val2' });
    const settings = agent.getSettings();

    // Verify it's a copy, not the same reference
    settings['key1'] = 'modified';
    expect(agent.getSetting('key1')).toBe('val1');
  });

  it('should overwrite previous settings on setSettings', () => {
    agent.setSettings({ a: '1' });
    agent.setSettings({ b: '2' });

    expect(agent.getSetting('a')).toBeUndefined();
    expect(agent.getSetting('b')).toBe('2');
  });
});

describe('AppManager settings', () => {
  const noop = () => {};

  it('should persist settings via setAppSettings', () => {
    const appsSettings: AppsSettings = {
      apps: {
        elevenlabs: {
          enabled: true,
          credentials: { apiKey: 'test' },
          installedAt: new Date().toISOString(),
          installedVersion: '1.0.0',
        },
      },
    };

    const manager = new AppManager(appsSettings, noop, noop);
    // Manually trigger loadInstalledApps (sync part — install the agent)
    manager.installApp('elevenlabs');

    const result = manager.setAppSettings('elevenlabs', { defaultTTSModel: 'eleven_turbo_v2_5' });
    expect(result).toBe(true);

    const saved = manager.getAppsSettings();
    expect(saved.apps['elevenlabs'].settings).toEqual({ defaultTTSModel: 'eleven_turbo_v2_5' });
  });

  it('should return false for non-existent app', () => {
    const manager = new AppManager({ apps: {} }, noop, noop);

    const result = manager.setAppSettings('nonexistent', { key: 'val' });
    expect(result).toBe(false);
  });

  it('should restore settings when re-enabling an app', async () => {
    const appsSettings: AppsSettings = {
      apps: {
        elevenlabs: {
          enabled: true,
          credentials: { apiKey: 'test' },
          settings: { defaultTTSModel: 'eleven_turbo_v2_5' },
          installedAt: new Date().toISOString(),
          installedVersion: '1.0.0',
        },
      },
    };

    const manager = new AppManager(appsSettings, noop, noop);
    // Load installed apps (reads from config including settings)
    await manager.loadInstalledApps();

    // Disable then re-enable
    manager.setAppEnabled('elevenlabs', false);
    manager.setAppEnabled('elevenlabs', true);

    const agent = manager.getApp('elevenlabs');
    expect(agent).toBeDefined();
    expect(agent!.getSetting('defaultTTSModel')).toBe('eleven_turbo_v2_5');
  });
});
