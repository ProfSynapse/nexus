import type { Plugin } from 'obsidian';
import { DEFAULT_STORAGE_SETTINGS } from '../../src/types';
import { Settings } from '../../src/settings';

describe('Settings', () => {
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
      maxShardBytes: 4 * 1024 * 1024
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
      maxShardBytes: 4 * 1024 * 1024
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
