/**
 * A synced change to the semantic search switch is applied live, not by reload.
 *
 * Settings.reconcileExternalSettings treated every synced key outside
 * `llmProviders` as "needs reload", so turning semantic search off on one
 * device showed "Reload Nexus to apply changes" on every other device and
 * changed nothing until then.
 *
 * What is real: NexusPlugin.onExternalSettingsChange and the Settings merge
 * and reload decision. What is faked: data.json (an in-memory object) and the
 * lifecycle manager, whose setEmbeddingsEnabled is a spy standing in for the
 * EmbeddingManager hot toggle (covered by EmbeddingManagerHotToggle.test.ts).
 */

import { App, Notice } from 'obsidian';
import NexusPlugin from '../../src/main';
import { Settings } from '../../src/settings';

jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), Notice: jest.fn() }));
jest.mock('../../src/core/ServiceManager', () => ({ ServiceManager: jest.fn() }));
jest.mock('../../src/core/PluginLifecycleManager', () => ({ PluginLifecycleManager: jest.fn() }));
jest.mock('../../src/utils/WasmEnsurer', () => ({ WasmEnsurer: jest.fn() }));

function fixture(initial: Record<string, unknown> = {}) {
  const disk: Record<string, unknown> = {
    llmProviders: { providers: {}, defaultTemperature: 0.5 },
    storage: { rootPath: 'Original' },
    enableEmbeddings: true,
    ...initial
  };
  const plugin = new NexusPlugin(new App(), {
    id: 'nexus', name: 'Nexus', version: 'test', minAppVersion: '1.5.7', author: 'test', description: 'Test.',
  });
  const loadData = jest.fn(async () => JSON.parse(JSON.stringify(disk)) as unknown);
  const saveData = jest.fn(async (data: unknown) => {
    for (const key of Object.keys(disk)) delete disk[key];
    Object.assign(disk, JSON.parse(JSON.stringify(data)));
  });
  const setEmbeddingsEnabled = jest.fn(async () => undefined);
  Object.assign(plugin, { loadData, saveData, lifecycleManager: { setEmbeddingsEnabled } });
  plugin.settings = new Settings(plugin);
  return { plugin, disk, saveData, setEmbeddingsEnabled };
}

describe('synced enableEmbeddings change', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not require a reload', async () => {
    const h = fixture();
    await h.plugin.settings.loadSettings();
    h.disk.enableEmbeddings = false;

    await expect(h.plugin.settings.reconcileExternalSettings()).resolves.toBe(false);
    expect(h.plugin.settings.settings.enableEmbeddings).toBe(false);
  });

  it('is hot-applied through the lifecycle, with no reload notice and no echo write', async () => {
    const h = fixture();
    await h.plugin.settings.loadSettings();
    h.disk.enableEmbeddings = false;

    await h.plugin.onExternalSettingsChange();

    expect(h.setEmbeddingsEnabled).toHaveBeenLastCalledWith(false);
    expect(Notice).not.toHaveBeenCalled();
    expect(h.saveData).not.toHaveBeenCalled();

    h.disk.enableEmbeddings = true;
    await h.plugin.onExternalSettingsChange();
    expect(h.setEmbeddingsEnabled).toHaveBeenLastCalledWith(true);
    expect(h.plugin.settings.settings.enableEmbeddings).toBe(true);
  });

  it('still asks for a reload when another reload-only key changes alongside it', async () => {
    const h = fixture();
    await h.plugin.settings.loadSettings();
    h.disk.enableEmbeddings = false;
    h.disk.storage = { rootPath: 'Synced root' };

    await h.plugin.onExternalSettingsChange();

    expect(h.setEmbeddingsEnabled).toHaveBeenLastCalledWith(false);
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(h.plugin.settings.settings.storage.rootPath).toBe('Original');
  });

  it('keeps a later local save from reverting the synced value', async () => {
    const h = fixture();
    await h.plugin.settings.loadSettings();
    h.disk.enableEmbeddings = false;
    await h.plugin.onExternalSettingsChange();

    h.plugin.settings.settings.defaultPromptId = 'local-edit';
    await h.plugin.settings.saveSettings();

    expect(h.saveData).toHaveBeenCalledTimes(1);
    expect(h.disk.defaultPromptId).toBe('local-edit');
    expect(h.disk.enableEmbeddings).toBe(false);
  });
});
