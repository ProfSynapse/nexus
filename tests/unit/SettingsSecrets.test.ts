import type { Plugin } from 'obsidian';
import { Settings } from '../../src/settings';
import type { MCPSettings } from '../../src/types';
import { SecretStore, type SecretStorageApi } from '../../src/services/secrets/SecretStore';
import {
  hydrateSecrets,
  migrateLegacyPlaintext,
  stripSecretsForPersist
} from '../../src/services/secrets/SettingsSecrets';

function createMockSecretStorage(): { api: SecretStorageApi; map: Map<string, string> } {
  const map = new Map<string, string>();
  const api: SecretStorageApi = {
    setSecret(id, secret) {
      if (!/^[a-z0-9-]+$/.test(id)) {
        throw new Error(`invalid id: ${id}`);
      }
      map.set(id, secret);
    },
    getSecret(id) {
      return map.has(id) ? (map.get(id) as string) : null;
    },
    listSecrets() {
      return [...map.keys()];
    }
  };
  return { api, map };
}

function settingsWithSecrets(): MCPSettings {
  return {
    enabledVault: true,
    llmProviders: {
      providers: {
        openai: { apiKey: 'sk-openai', enabled: true },
        openrouter: {
          apiKey: 'sk-or',
          enabled: true,
          oauth: { connected: true, providerId: 'openrouter', connectedAt: 1, refreshToken: 'rt-secret' }
        }
      },
      defaultModel: { provider: 'openai', model: 'gpt-4o' }
    },
    apps: {
      apps: {
        elevenlabs: {
          enabled: true,
          credentials: { apiKey: 'el-key', webhookUrl: 'https://hook' },
          installedAt: '2026-01-01',
          installedVersion: '1.0.0'
        }
      }
    }
  } as unknown as MCPSettings;
}

describe('SettingsSecrets boundary (unit)', () => {
  it('strips every secret field on persist and stores it in secretStorage', () => {
    const { api, map } = createMockSecretStorage();
    const store = new SecretStore({ secretStorage: api });
    const settings = settingsWithSecrets();

    const { settings: stripped, persisted } = stripSecretsForPersist(settings, store);

    expect(persisted).toBe(true);
    // Persisted clone has secrets blanked
    expect(stripped.llmProviders?.providers.openai.apiKey).toBe('');
    expect(stripped.llmProviders?.providers.openrouter.apiKey).toBe('');
    expect(stripped.llmProviders?.providers.openrouter.oauth?.refreshToken).toBe('');
    expect(stripped.apps?.apps.elevenlabs.credentials.apiKey).toBe('');
    expect(stripped.apps?.apps.elevenlabs.credentials.webhookUrl).toBe('');
    // Original in-memory settings untouched
    expect(settings.llmProviders?.providers.openai.apiKey).toBe('sk-openai');
    // secretStorage now holds the values under stable ids
    expect(map.get('nexus-llm-openai-apikey')).toBe('sk-openai');
    expect(map.get('nexus-llm-openrouter-apikey')).toBe('sk-or');
    expect(map.get('nexus-llm-openrouter-oauth-refresh')).toBe('rt-secret');
    expect(map.get('nexus-app-elevenlabs-apikey')).toBe('el-key');
    expect(map.get('nexus-app-elevenlabs-webhookurl')).toBe('https://hook');
  });

  it('hydrate fills blanked secret fields back from secretStorage', () => {
    const { api } = createMockSecretStorage();
    const store = new SecretStore({ secretStorage: api });
    const original = settingsWithSecrets();
    stripSecretsForPersist(original, store);

    // Simulate a freshly loaded data.json with blanked secrets
    const loaded = settingsWithSecrets();
    loaded.llmProviders!.providers.openai.apiKey = '';
    loaded.llmProviders!.providers.openrouter.apiKey = '';
    loaded.llmProviders!.providers.openrouter.oauth!.refreshToken = '';
    loaded.apps!.apps.elevenlabs.credentials.apiKey = '';
    loaded.apps!.apps.elevenlabs.credentials.webhookUrl = '';

    hydrateSecrets(loaded, store);

    expect(loaded.llmProviders?.providers.openai.apiKey).toBe('sk-openai');
    expect(loaded.llmProviders?.providers.openrouter.apiKey).toBe('sk-or');
    expect(loaded.llmProviders?.providers.openrouter.oauth?.refreshToken).toBe('rt-secret');
    expect(loaded.apps?.apps.elevenlabs.credentials.apiKey).toBe('el-key');
    expect(loaded.apps?.apps.elevenlabs.credentials.webhookUrl).toBe('https://hook');
  });

  it('migrateLegacyPlaintext moves plaintext into the store and is idempotent', () => {
    const { api, map } = createMockSecretStorage();
    const store = new SecretStore({ secretStorage: api });
    const settings = settingsWithSecrets();

    expect(migrateLegacyPlaintext(settings, store)).toBe(true);
    expect(map.get('nexus-llm-openai-apikey')).toBe('sk-openai');

    // After a strip pass the in-memory secrets are blanked; migration is a no-op.
    const { settings: stripped } = stripSecretsForPersist(settings, store);
    expect(migrateLegacyPlaintext(stripped, store)).toBe(false);
  });

  it('is a no-op when secretStorage is unavailable (plaintext fallback)', () => {
    const store = new SecretStore({});
    const settings = settingsWithSecrets();

    const { settings: result, persisted } = stripSecretsForPersist(settings, store);
    expect(persisted).toBe(false);
    expect(result).toBe(settings);
    expect(result.llmProviders?.providers.openai.apiKey).toBe('sk-openai');

    expect(migrateLegacyPlaintext(settings, store)).toBe(false);
    hydrateSecrets(settings, store); // does not throw, no mutation
    expect(settings.llmProviders?.providers.openai.apiKey).toBe('sk-openai');
  });
});

describe('Settings class persistence boundary', () => {
  function makePlugin(initialData: unknown, api?: SecretStorageApi): {
    plugin: Plugin;
    saved: Record<string, unknown>[];
  } {
    const saved: Record<string, unknown>[] = [];
    let store = initialData;
    const plugin = {
      app: api ? { secretStorage: api } : {},
      loadData: jest.fn(async () => store),
      saveData: jest.fn(async (data: Record<string, unknown>) => {
        saved.push(data);
        store = data;
      })
    } as unknown as Plugin;
    return { plugin, saved };
  }

  it('saveSettings strips plaintext from data.json and stores it in secretStorage', async () => {
    const { api, map } = createMockSecretStorage();
    const { plugin, saved } = makePlugin({ enabledVault: true }, api);

    const settings = new Settings(plugin);
    settings.settings = settingsWithSecrets();
    await settings.saveSettings();

    const persisted = saved[saved.length - 1];
    const providers = (persisted.llmProviders as MCPSettings['llmProviders'])!.providers;
    expect(providers.openai.apiKey).toBe('');
    expect(map.get('nexus-llm-openai-apikey')).toBe('sk-openai');
    // Runtime settings still populated
    expect(settings.settings.llmProviders?.providers.openai.apiKey).toBe('sk-openai');
  });

  it('loadSettings migrates legacy plaintext then re-saves blanked data.json', async () => {
    const { api, map } = createMockSecretStorage();
    const legacy = {
      enabledVault: true,
      llmProviders: {
        providers: { openai: { apiKey: 'sk-legacy', enabled: true } },
        defaultModel: { provider: 'openai', model: 'gpt-4o' }
      }
    };
    const { plugin, saved } = makePlugin(legacy, api);

    const settings = new Settings(plugin);
    await settings.loadSettings();

    // Secret moved into the store
    expect(map.get('nexus-llm-openai-apikey')).toBe('sk-legacy');
    // Runtime value hydrated/preserved
    expect(settings.settings.llmProviders?.providers.openai.apiKey).toBe('sk-legacy');
    // A re-save happened, blanking the persisted secret
    expect(saved.length).toBeGreaterThan(0);
    const persisted = saved[saved.length - 1];
    const providers = (persisted.llmProviders as MCPSettings['llmProviders'])!.providers;
    expect(providers.openai.apiKey).toBe('');
  });

  it('loadSettings hydrates secrets from store when data.json is blanked', async () => {
    const { api } = createMockSecretStorage();
    api.setSecret('nexus-llm-openai-apikey', 'sk-stored');
    const blanked = {
      enabledVault: true,
      llmProviders: {
        providers: { openai: { apiKey: '', enabled: true } },
        defaultModel: { provider: 'openai', model: 'gpt-4o' }
      }
    };
    const { plugin } = makePlugin(blanked, api);

    const settings = new Settings(plugin);
    await settings.loadSettings();

    expect(settings.settings.llmProviders?.providers.openai.apiKey).toBe('sk-stored');
  });

  it('without secretStorage, behavior is unchanged: plaintext persists', async () => {
    const { plugin, saved } = makePlugin({ enabledVault: true });

    const settings = new Settings(plugin);
    settings.settings = settingsWithSecrets();
    await settings.saveSettings();

    const persisted = saved[saved.length - 1];
    const providers = (persisted.llmProviders as MCPSettings['llmProviders'])!.providers;
    expect(providers.openai.apiKey).toBe('sk-openai');
  });
});
