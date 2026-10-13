/** Two loaded Settings owners model devices whose data.json receives another device's edits. */
import type { Plugin } from 'obsidian';
import { Settings } from '../../src/settings';
import type { MCPSettings } from '../../src/types';
import type { SecretStorageApi } from '../../src/services/secrets/SecretStore';
import { cloneSettings, mergeSettingsChanges, reconcileSettingsInPlace } from '../../src/services/settings/SettingsMerge';
import { LLMSettingsNotifier } from '../../src/services/llm/LLMSettingsNotifier';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(extra: Record<string, unknown> = {}, secretStorage?: SecretStorageApi) {
  let disk: Record<string, unknown> = {
    enabledVault: true,
    llmProviders: { providers: { anthropic: { apiKey: 'old-key', enabled: true, models: { one: { enabled: true } } } }, defaultModel: { provider: 'anthropic', model: 'one' } },
    storage: { rootPath: 'Original' },
    apps: { apps: { elevenlabs: { enabled: true, credentials: { apiKey: 'old-app-key' } } } },
    memory: { preserveUnknownSetting: true },
    pluginStorage: { preserveRuntimeState: true },
    ...extra,
  };
  const loadData = jest.fn(async () => cloneSettings(disk));
  const saveData = jest.fn(async (data: Record<string, unknown>) => { disk = cloneSettings(data); });
  const createOwner = () => new Settings({ app: { secretStorage }, loadData, saveData } as unknown as Plugin);
  return { createOwner, loadData, saveData, get disk() { return disk; }, get providers() { return (disk as unknown as MCPSettings).llmProviders; } };
}

function secretStore() {
  const values = new Map<string, string>();
  const api: SecretStorageApi = {
    getSecret: id => values.get(id) ?? null,
    setSecret: jest.fn((id, value) => { values.set(id, value); }),
    listSecrets: () => [...values.keys()],
  };
  return { api, values };
}

describe('Settings sync merge', () => {
  beforeEach(() => jest.spyOn(LLMSettingsNotifier, 'notify').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('keeps a newer credential when a second stale owner saves an unrelated nested provider edit', async () => {
    const h = fixture();
    const first = h.createOwner();
    const second = h.createOwner();
    await first.loadSettings(); await second.loadSettings();
    first.settings.llmProviders.providers.anthropic.apiKey = 'new-key';
    await first.saveSettings();
    second.settings.llmProviders.providers.anthropic.models!.one.enabled = false;
    await second.saveSettings();
    expect(h.providers.providers.anthropic.apiKey).toBe('new-key');
    expect(h.providers.providers.anthropic.models!.one.enabled).toBe(false);
    expect(second.settings.llmProviders.providers.anthropic.apiKey).toBe('new-key');
    expect(h.disk.memory).toEqual({ preserveUnknownSetting: true });
    expect(h.disk.pluginStorage).toEqual({ preserveRuntimeState: true });
    const restarted = h.createOwner();
    await restarted.loadSettings();
    expect(restarted.settings.llmProviders.providers.anthropic.apiKey).toBe('new-key');
    expect(restarted.settings.llmProviders.providers.anthropic.models!.one.enabled).toBe(false);
  });

  it('preserves incoming storage/app changes without switching running services or echoing stale values', async () => {
    const h = fixture(); const settings = h.createOwner(); await settings.loadSettings();
    const originalRoot = settings.settings.storage.rootPath;
    const originalApp = cloneSettings(settings.settings.apps);
    h.disk.storage = { rootPath: 'Synced' };
    h.disk.apps = { apps: { elevenlabs: { enabled: false, credentials: { apiKey: 'new-app-key' } } } };
    expect(await settings.reconcileExternalSettings()).toBe(true);
    expect(settings.settings.storage.rootPath).toBe(originalRoot);
    expect(settings.settings.apps).toEqual(originalApp);
    settings.settings.defaultPromptId = 'local-prompt';
    await settings.saveSettings();
    expect(h.disk.storage).toEqual({ rootPath: 'Synced' });
    expect(h.disk.apps).toEqual({ apps: { elevenlabs: { enabled: false, credentials: { apiKey: 'new-app-key' } } } });
    expect(h.disk.defaultPromptId).toBe('local-prompt');
  });

  it('updates retained provider references without saving, while unsaved local provider edits remain dirty', async () => {
    const h = fixture(); const settings = h.createOwner(); await settings.loadSettings();
    const providerMap = settings.settings.llmProviders;
    const provider = providerMap.providers.anthropic;
    provider.userDescription = 'Local edit';
    h.providers.providers.anthropic.apiKey = 'remote-key';
    expect(await settings.reconcileExternalSettings()).toBe(false);
    expect(settings.settings.llmProviders).toBe(providerMap);
    expect(settings.settings.llmProviders.providers.anthropic).toBe(provider);
    expect(provider.apiKey).toBe('remote-key');
    expect(provider.userDescription).toBe('Local edit');
    expect(h.saveData).not.toHaveBeenCalled();
    expect(LLMSettingsNotifier.notify).toHaveBeenCalledTimes(1);
    await settings.reconcileExternalSettings();
    expect(LLMSettingsNotifier.notify).toHaveBeenCalledTimes(1);
    await settings.saveSettings();
    expect(h.providers.providers.anthropic.userDescription).toBe('Local edit');
  });

  it('retains edits made during an in-flight save for the next save', async () => {
    const h = fixture(); const settings = h.createOwner(); await settings.loadSettings();
    settings.settings.llmProviders.providers.anthropic.apiKey = 'first-edit';
    const entered = deferred(); const release = deferred();
    h.loadData.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return cloneSettings(h.disk); });
    const saving = settings.saveSettings(); await entered.promise;
    settings.settings.llmProviders.providers.anthropic.apiKey = 'second-edit';
    release.resolve(); await saving;
    expect(h.providers.providers.anthropic.apiKey).toBe('first-edit');
    expect(settings.settings.llmProviders.providers.anthropic.apiKey).toBe('second-edit');
    await settings.saveSettings();
    expect(h.providers.providers.anthropic.apiKey).toBe('second-edit');
  });

  it('keeps dirty changes after a rejected save and merges fresh remote state on retry', async () => {
    const h = fixture(); const settings = h.createOwner(); await settings.loadSettings();
    settings.settings.defaultPromptId = 'local';
    h.saveData.mockRejectedValueOnce(new Error('disk full'));
    await expect(settings.saveSettings()).rejects.toThrow('disk full');
    h.providers.providers.anthropic.apiKey = 'remote-key';
    await settings.saveSettings();
    expect(h.disk.defaultPromptId).toBe('local');
    expect(h.providers.providers.anthropic.apiKey).toBe('remote-key');
  });

  it('restores builtin provider defaults when a first key edit produces sparse persisted settings', async () => {
    const h = fixture({ llmProviders: { providers: {} } });
    const settings = h.createOwner(); await settings.loadSettings();
    const defaults = cloneSettings(settings.settings.llmProviders.providers.anthropic);
    settings.settings.llmProviders.providers.anthropic.apiKey = 'first-key';
    await settings.saveSettings();
    expect(h.providers.providers.anthropic).toEqual({ apiKey: 'first-key' });
    const restarted = h.createOwner(); await restarted.loadSettings();
    expect(restarted.settings.llmProviders.providers.anthropic).toEqual({ ...defaults, apiKey: 'first-key' });
    expect(restarted.settings.llmProviders.providers.anthropic.enabled).toBe(false);
  });

  it('preserves remote deletions and local deletions without resurrecting untouched defaults', async () => {
    const h = fixture({ defaultPromptId: 'remove-me' });
    h.providers.providers.custom = { apiKey: 'custom-key', enabled: true };
    const settings = h.createOwner(); await settings.loadSettings();
    delete h.providers.providers.custom;
    delete settings.settings.defaultPromptId;
    settings.settings.llmProviders.defaultTemperature = 0.8;
    await settings.saveSettings();
    expect(h.providers.providers).not.toHaveProperty('custom');
    expect(h.disk).not.toHaveProperty('defaultPromptId');
    expect(h.disk).not.toHaveProperty('enableEmbeddings');
    expect(h.providers.defaultTemperature).toBe(0.8);
  });

  it('ignores bookkeeping and missing defaults when deciding whether a reload is needed', async () => {
    const h = fixture(); const settings = h.createOwner(); await settings.loadSettings();
    h.disk.workflowScheduler = { lastCheckAt: 1234 };
    h.disk.pluginStorage = { changed: true };
    expect(await settings.reconcileExternalSettings()).toBe(false);
  });

  it('does not reconcile before initial settings load', async () => {
    const h = fixture();
    expect(await h.createOwner().reconcileExternalSettings()).toBe(false);
    expect(h.loadData).not.toHaveBeenCalled();
  });

  it('hydrates latest secure values before merging an unrelated stale edit', async () => {
    const store = secretStore(); store.values.set('nexus-llm-anthropic-apikey', 'stored-old');
    const h = fixture({ secureApiKeyStorage: true, apps: { apps: {} } }, store.api);
    h.providers.providers.anthropic.apiKey = '';
    const settings = h.createOwner(); await settings.loadSettings();
    expect(h.saveData).not.toHaveBeenCalled();
    store.values.set('nexus-llm-anthropic-apikey', 'stored-new');
    settings.settings.defaultPromptId = 'local';
    await settings.saveSettings();
    expect(store.values.get('nexus-llm-anthropic-apikey')).toBe('stored-new');
    expect(h.providers.providers.anthropic.apiKey).toBe('');
    expect(settings.settings.llmProviders.providers.anthropic.apiKey).toBe('stored-new');
  });

  it('hydrates secure input before switching storage off, then clears only after a successful save', async () => {
    const store = secretStore(); store.values.set('nexus-llm-anthropic-apikey', 'stored-old');
    const h = fixture({ secureApiKeyStorage: true, apps: { apps: {} } }, store.api); h.providers.providers.anthropic.apiKey = '';
    const settings = h.createOwner(); await settings.loadSettings();
    store.values.set('nexus-llm-anthropic-apikey', 'stored-new');
    h.saveData.mockRejectedValueOnce(new Error('disk full'));
    await expect(settings.setSecureApiKeyStorage(false)).rejects.toThrow('disk full');
    expect(store.values.get('nexus-llm-anthropic-apikey')).toBe('stored-new');
    await settings.setSecureApiKeyStorage(false);
    expect(h.providers.providers.anthropic.apiKey).toBe('stored-new');
    expect(store.values.get('nexus-llm-anthropic-apikey')).toBe('');
  });

  it('preserves a newer plaintext fallback across restart when secure writes have failed', async () => {
    const store = secretStore(); store.values.set('nexus-llm-anthropic-apikey', 'stored-old');
    const h = fixture({ secureApiKeyStorage: true, apps: { apps: {} } }, store.api); h.providers.providers.anthropic.apiKey = '';
    const settings = h.createOwner(); await settings.loadSettings();
    settings.settings.llmProviders.providers.anthropic.apiKey = 'new-fallback';
    jest.mocked(store.api.setSecret).mockImplementation(() => { throw new Error('locked'); });
    await settings.saveSettings();
    expect(h.providers.providers.anthropic.apiKey).toBe('new-fallback');
    const restarted = h.createOwner(); await restarted.loadSettings();
    expect(restarted.settings.llmProviders.providers.anthropic.apiKey).toBe('new-fallback');
    expect(store.values.get('nexus-llm-anthropic-apikey')).toBe('stored-old');
  });
});

describe('settings merge primitives', () => {
  it('treats arrays atomically and preserves unrelated nested incoming edits', () => {
    const before = { notes: ['a'], nested: { first: 1, second: 2 } };
    expect(mergeSettingsChanges(before, { notes: ['b'], nested: { first: 3, second: 2 } }, { notes: ['c'], nested: { first: 1, second: 4 } }))
      .toEqual({ notes: ['b'], nested: { first: 3, second: 4 } });
  });

  it('merges independent newly-added object keys', () => {
    expect(mergeSettingsChanges({}, { extra: { local: true } }, { extra: { remote: true } }))
      .toEqual({ extra: { local: true, remote: true } });
  });

  it('treats __proto__ as data without changing object prototypes', () => {
    const local = JSON.parse('{"__proto__":{"arbitrary":true}}') as Record<string, unknown>;
    const merged = mergeSettingsChanges({}, local, {});
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(true);
    const target = {};
    reconcileSettingsInPlace(target, local);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(true);
  });
});
