import type { Plugin } from 'obsidian';
import { DEFAULT_STORAGE_SETTINGS } from '../../src/types';
import { Settings } from '../../src/settings';

describe('Settings', () => {
  it('normalizes malformed instruction metadata without retaining unchecked nested fields', async () => {
    const plugin = { loadData: jest.fn(async () => ({ instructionLibrary: { version: 1, items: { bad: { categories: ['x'] }, '["skill","nexus","review"]': { categories: [' ', 'Research', 'Research', 1], archived: true } } } })), saveData: jest.fn() } as unknown as Plugin;
    const settings = new Settings(plugin);
    await settings.loadSettings();
    expect(settings.settings.instructionLibrary).toEqual({ version: 1, items: { '["skill","nexus","review"]': { categories: ['Research'], archived: true } } });
  });
  it('starts with storage defaults in the runtime settings object', () => {
    const plugin = {
      loadData: jest.fn(async () => null),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);

    expect(settings.settings.storage).toEqual(DEFAULT_STORAGE_SETTINGS);
  });

  it('loads storage defaults when persisted storage settings are absent', async () => {
    const plugin = {
      loadData: jest.fn(async () => ({
        enabledVault: true
      })),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect(settings.settings.storage).toEqual({
      schemaVersion: 2,
      rootPath: 'Nexus',
      maxShardBytes: 1024 * 1024,
      audioSubfolder: 'audio'
    });
  });

  it('merges partial persisted storage settings with defaults', async () => {
    const plugin = {
      loadData: jest.fn(async () => ({
        enabledVault: true,
        storage: {
          rootPath: 'storage/assistant-data'
        }
      })),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect(settings.settings.storage).toEqual({
      schemaVersion: 2,
      rootPath: 'storage/assistant-data',
      maxShardBytes: 1024 * 1024,
      audioSubfolder: 'audio'
    });
  });

  it.each([
    ['openrouter', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'],
    ['google', 'gemini-3.1-flash-image-preview', 'gemini-nano-banana-2.1'],
    ['google', 'gemini-3-pro-image-preview', 'gemini-3-pro-image'],
    ['openai', 'gpt-image-1', 'gpt-image-2.5-sunburst'],
    ['openai', 'gpt-image-1.5', 'gpt-image-2.5-sunburst'],
    ['openai', 'gpt-image-1-mini', 'gpt-image-2.5-flare'],
    ['openrouter', 'gpt-5-image', 'gpt-image-2.5-sunburst'],
    ['openrouter', 'gpt-5-image-mini', 'gpt-image-2.5-flare'],
  ])('moves a saved %s/%s image default to the documented successor %s and keeps the provider', async (provider, model, replacement) => {
    const plugin = {
      loadData: jest.fn(async () => ({
        llmProviders: {
          defaultImageModel: { provider, model }
        }
      })),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect(settings.settings.llmProviders.defaultImageModel).toEqual({ provider, model: replacement });
    // Normalized in memory only: loading never writes the synced data.json.
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it('moves a saved Google Veo 3.1 preview video default to Gemini Omni Flash, keeping ratio and resolution', async () => {
    const plugin = {
      loadData: jest.fn(async () => ({
        llmProviders: {
          defaultVideoModel: { provider: 'google', model: 'veo-3.1-generate-preview', aspectRatio: '9:16', resolution: '1080p' }
        }
      })),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect(settings.settings.llmProviders.defaultVideoModel).toEqual({
      provider: 'google',
      model: 'gemini-omni-1.1-flash',
      aspectRatio: '9:16',
      resolution: '1080p'
    });
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it('falls back to the successor default for a saved video aspect ratio it does not support', async () => {
    const plugin = {
      loadData: jest.fn(async () => ({
        llmProviders: {
          defaultVideoModel: { provider: 'google', model: 'veo-3.1-fast-generate-preview', aspectRatio: '1:1', resolution: '4k' }
        }
      })),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect(settings.settings.llmProviders.defaultVideoModel).toEqual({
      provider: 'google',
      model: 'gemini-omni-1.1-flash',
      aspectRatio: '16:9',
      resolution: '4k'
    });
  });

  it('leaves an OpenRouter Veo video default alone', async () => {
    const saved = { provider: 'openrouter', model: 'google/veo-3.1', aspectRatio: '16:9', resolution: '720p' };
    const plugin = {
      loadData: jest.fn(async () => ({ llmProviders: { defaultVideoModel: saved } })),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect(settings.settings.llmProviders.defaultVideoModel).toEqual(saved);
  });

  it('normalizes a retired video default that arrives through sync without rewriting data.json', async () => {
    let disk: Record<string, unknown> = { llmProviders: { defaultVideoModel: { provider: 'openrouter', model: 'google/veo-3.1-fast' } } };
    const plugin = {
      loadData: jest.fn(async () => disk),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();
    disk = { llmProviders: { defaultVideoModel: { provider: 'google', model: 'veo-3.1-generate-preview', aspectRatio: '16:9', resolution: '720p' } } };
    await settings.reconcileExternalSettings();

    expect(settings.settings.llmProviders.defaultVideoModel).toMatchObject({ provider: 'google', model: 'gemini-omni-1.1-flash' });
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it('leaves a saved image default alone when it is not the retired model', async () => {
    const plugin = {
      loadData: jest.fn(async () => ({
        llmProviders: {
          defaultImageModel: { provider: 'google', model: 'gemini-3.1-flash-lite-image' }
        }
      })),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect(settings.settings.llmProviders.defaultImageModel).toEqual({
      provider: 'google',
      model: 'gemini-3.1-flash-lite-image'
    });
  });

  it('does not load or overwrite runtime pluginStorage state through normal settings saves', async () => {
    const initialData = {
      enabledVault: true,
      pluginStorage: {
        storageVersion: 2,
        sourceOfTruthLocation: 'vault-root',
        migration: {
          state: 'verified',
          activeDestination: 'Nexus/data',
          legacySourcesDetected: []
        }
      }
    };

    const plugin = {
      loadData: jest.fn(async () => initialData),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect((settings.settings as { pluginStorage?: unknown }).pluginStorage).toBeUndefined();

    settings.settings.enabledVault = false;
    await settings.saveSettings();

    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    const savedData = plugin.saveData.mock.calls[0][0] as {
      enabledVault: boolean;
      pluginStorage?: unknown;
    };
    expect(savedData.enabledVault).toBe(false);
    expect(savedData.pluginStorage).toEqual(initialData.pluginStorage);
  });
});
