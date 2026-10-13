/** Drive the real plugin callback and Settings boundary; only startup/UI services are stubbed. */
import { App, Notice, Platform } from 'obsidian';
import NexusPlugin from '../../src/main';
import { Settings } from '../../src/settings';
import { LLMSettingsNotifier } from '../../src/services/llm/LLMSettingsNotifier';

jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), Notice: jest.fn() }));
jest.mock('../../src/core/ServiceManager', () => ({ ServiceManager: jest.fn() }));
jest.mock('../../src/core/PluginLifecycleManager', () => ({ PluginLifecycleManager: jest.fn() }));
jest.mock('../../src/utils/WasmEnsurer', () => ({ WasmEnsurer: jest.fn() }));

function fixture() {
  const disk = {
    llmProviders: { providers: { anthropic: { enabled: true, apiKey: 'old-key' } }, defaultTemperature: 0.5 },
    storage: { rootPath: 'Original' },
  };
  const plugin = new NexusPlugin(new App(), {
    id: 'nexus', name: 'Nexus', version: 'test', minAppVersion: '1.5.7', author: 'test', description: 'Test.',
  });
  const loadData = jest.fn(async () => JSON.parse(JSON.stringify(disk)) as unknown);
  const saveData = jest.fn(async () => undefined);
  Object.assign(plugin, { loadData, saveData });
  plugin.settings = new Settings(plugin);
  return { plugin, disk, loadData, saveData };
}

describe('Obsidian external settings callback', () => {
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => jest.clearAllMocks());

  it('updates the provider in place, retains an unsaved local edit, and never echoes a synced write', async () => {
    const h = fixture();
    await h.plugin.settings.loadSettings();
    const providers = h.plugin.settings.settings.llmProviders;
    const anthropic = providers.providers.anthropic;
    providers.defaultTemperature = 0.8;
    h.disk.llmProviders.providers.anthropic.apiKey = 'new-key';
    const notify = jest.spyOn(LLMSettingsNotifier, 'notify');

    await h.plugin.onExternalSettingsChange();

    expect(h.plugin.settings.settings.llmProviders).toBe(providers);
    expect(providers.providers.anthropic).toBe(anthropic);
    expect(anthropic.apiKey).toBe('new-key');
    expect(providers.defaultTemperature).toBe(0.8);
    expect(h.saveData).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    await h.plugin.onExternalSettingsChange();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('asks for reload once instead of changing a live storage root', async () => {
    const h = fixture();
    await h.plugin.settings.loadSettings();
    h.disk.storage.rootPath = 'Synced root';
    await h.plugin.onExternalSettingsChange();
    await h.plugin.onExternalSettingsChange();
    expect(h.plugin.settings.settings.storage.rootPath).toBe('Original');
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(h.saveData).not.toHaveBeenCalled();
  });

  it('ignores sync callbacks after unload', async () => {
    const h = fixture();
    await h.plugin.settings.loadSettings();
    const desktop = Platform.isDesktop;
    Platform.isDesktop = false;
    try { h.plugin.onunload(); } finally { Platform.isDesktop = desktop; }
    h.loadData.mockClear();
    await h.plugin.onExternalSettingsChange();
    expect(h.loadData).not.toHaveBeenCalled();
  });

  it('does not revive providers when unload happens during an external settings read', async () => {
    const h = fixture();
    await h.plugin.settings.loadSettings();
    const notify = jest.spyOn(LLMSettingsNotifier, 'notify');
    let resolve!: (value: unknown) => void;
    h.loadData.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = h.plugin.onExternalSettingsChange();
    await Promise.resolve();
    await Promise.resolve();
    const desktop = Platform.isDesktop;
    Platform.isDesktop = false;
    try { h.plugin.onunload(); } finally { Platform.isDesktop = desktop; }
    h.disk.llmProviders.providers.anthropic.apiKey = 'new-key';
    resolve(h.disk);
    await pending;
    expect(h.plugin.settings.settings.llmProviders.providers.anthropic.apiKey).toBe('old-key');
    expect(notify).not.toHaveBeenCalled();
  });
});
