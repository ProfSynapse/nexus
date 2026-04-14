jest.mock('obsidian', () => ({
  App: jest.fn(),
  Plugin: jest.fn(),
  PluginSettingTab: jest.fn(),
  Notice: jest.fn(),
  ButtonComponent: jest.fn(),
  Setting: jest.fn(),
  TextComponent: jest.fn(),
  Platform: { isMobile: false, isDesktop: true },
  normalizePath: (value: string) => value
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/')
}), { virtual: true });

jest.mock('../../src/components/shared/ChatSettingsRenderer', () => ({
  ChatSettingsRenderer: jest.fn().mockImplementation(() => ({
    render: jest.fn(),
    destroy: jest.fn()
  }))
}));

jest.mock('../../src/services/llm/providers/ProviderManager', () => ({
  LLMProviderManager: jest.fn()
}));

jest.mock('../../src/agents/ingestManager/tools/services/IngestCapabilityService', () => ({
  getIngestCapabilityOptions: jest.fn().mockResolvedValue({ ocrProviders: [], transcriptionProviders: [] }),
  normalizeIngestSelection: jest.fn().mockReturnValue({ provider: undefined, model: undefined })
}));

import type { App } from 'obsidian';
import { changeDataFolderPath } from '../../src/settings/storage/changeDataFolderPath';
import { Settings } from '../../src/settings';
import { resolveVaultRoot } from '../../src/database/storage/VaultRootResolver';

describe('DataTab data folder changes', () => {
  const createApp = (): App => ({
    vault: {
      configDir: '.obsidian',
    },
  } as unknown as App);

  const createSettings = (rootPath = 'Nexus'): Settings => ({
    settings: {
      storage: {
        schemaVersion: 2,
        rootPath,
        maxShardBytes: 4 * 1024 * 1024
      }
    },
    saveSettings: jest.fn().mockResolvedValue(undefined)
  } as unknown as Settings);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects invalid data folder paths without persisting', async () => {
    const result = await changeDataFolderPath({
      app: createApp(),
      settings: createSettings(),
      nextRootPath: '.obsidian/plugins/nexus'
    });

    expect(result.success).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.message).toContain('Paths under .obsidian/plugins are not allowed');
  });

  it('persists a valid path immediately when no runtime adapter is available', async () => {
    const settings = createSettings('Nexus');

    const result = await changeDataFolderPath({
      app: createApp(),
      settings,
      nextRootPath: 'storage/assistant-data'
    });

    expect(result.success).toBe(true);
    expect(result.persisted).toBe(true);
    expect(result.relocated).toBe(false);
    expect(result.applyOnNextStartup).toBe(true);
    expect(settings.saveSettings).toHaveBeenCalledTimes(1);
    expect(settings.settings.storage?.rootPath).toBe('storage/assistant-data');
  });

  it('relocates data folder with the runtime adapter before persisting', async () => {
    const settings = createSettings('Nexus');
    const app = createApp();
    const adapter = {
      isReady: jest.fn().mockReturnValue(true),
      relocateVaultRoot: jest.fn().mockResolvedValue({
        success: true,
        verified: true,
        switched: true,
        message: 'Relocated',
        errors: []
      })
    };
    const serviceManager = {
      getServiceIfReady: jest.fn().mockReturnValue(adapter)
    };

    const result = await changeDataFolderPath({
      app,
      settings,
      serviceManager: serviceManager as never,
      nextRootPath: 'storage/assistant-data'
    });

    expect(result.success).toBe(true);
    expect(result.persisted).toBe(true);
    expect(result.relocated).toBe(true);
    expect(result.applyOnNextStartup).toBe(false);
    expect(adapter.relocateVaultRoot).toHaveBeenCalledWith('storage/assistant-data', {
      maxShardBytes: 4 * 1024 * 1024
    });
    expect(settings.saveSettings).toHaveBeenCalledTimes(1);
    expect(settings.settings.storage?.rootPath).toBe('storage/assistant-data');
    expect(resolveVaultRoot(settings.settings, { configDir: '.obsidian' }).resolvedPath).toBe('storage/assistant-data');
  });

  it('does not persist when runtime relocation fails', async () => {
    const settings = createSettings('Nexus');
    const adapter = {
      isReady: jest.fn().mockReturnValue(true),
      relocateVaultRoot: jest.fn().mockResolvedValue({
        success: false,
        verified: false,
        switched: false,
        message: 'conflict',
        errors: ['conflict']
      })
    };
    const serviceManager = {
      getServiceIfReady: jest.fn().mockReturnValue(adapter)
    };

    const result = await changeDataFolderPath({
      app: createApp(),
      settings,
      serviceManager: serviceManager as never,
      nextRootPath: 'storage/assistant-data'
    });

    expect(result.success).toBe(false);
    expect(result.persisted).toBe(false);
    expect(settings.saveSettings).not.toHaveBeenCalled();
    expect(adapter.relocateVaultRoot).toHaveBeenCalledTimes(1);
  });
});
