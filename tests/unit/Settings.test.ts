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
      schemaVersion: 1,
      rootPath: 'Nexus',
      maxShardBytes: 4 * 1024 * 1024
    });
  });

  it('merges partial persisted storage settings with defaults', async () => {
    const plugin = {
      loadData: jest.fn(async () => ({
        enabledVault: true,
        storage: {
          rootPath: 'storage/nexus'
        }
      })),
      saveData: jest.fn(async () => undefined)
    } as unknown as Plugin;

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect(settings.settings.storage).toEqual({
      schemaVersion: 1,
      rootPath: 'storage/nexus',
      maxShardBytes: 4 * 1024 * 1024
    });
  });
});
