import { Plugin } from 'obsidian';
import { MCPSettings, DEFAULT_SETTINGS, type LLMProviderConfig } from './types';
import { pluginDataLock } from './utils/pluginDataLock';
import { SecretStore, type SecretStorageHost } from './services/secrets/SecretStore';
import {
    clearStoredSecrets,
    hydrateSecrets,
    migrateLegacyPlaintext,
    stripSecretsForPersist
} from './services/secrets/SettingsSecrets';

/**
 * Settings manager
 * Handles loading and saving plugin settings
 */
export class Settings {
    private plugin: Plugin;
    private secretStore: SecretStore;
    settings: MCPSettings;

    /**
     * Create a new settings manager
     * @param plugin Plugin instance
     */
    constructor(plugin: Plugin) {
        this.plugin = plugin;
        this.secretStore = new SecretStore((plugin.app ?? {}) as unknown as SecretStorageHost);
        this.settings = DEFAULT_SETTINGS;
    }

    /**
     * Load settings from plugin data
     * Now synchronous with minimal validation for fast startup
     */
    async loadSettings(): Promise<void> {
        try {
            const loadedData: unknown = await this.plugin.loadData();
            this.applyLoadedData(loadedData);
            // Secrets only leave data.json when the user has opted in. When the
            // option is off, keys stay in the synced settings as before.
            if (this.settings.secureApiKeyStorage) {
                hydrateSecrets(this.settings, this.secretStore);
                if (migrateLegacyPlaintext(this.settings, this.secretStore)) {
                    await this.saveSettings();
                }
            }
        } catch {
            // Continue with defaults - plugin should still function
        }
    }
    
    /**
     * Apply loaded data with minimal validation for fast startup
     */
    private applyLoadedData(loadedData: unknown): void {
        if (!loadedData || typeof loadedData !== 'object') {
            return; // Use defaults
        }
        
        // Start with default settings (includes memory)
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        
        // Quick shallow merge for startup - detailed validation deferred
        try {
            const sanitizedLoadedData = { ...(loadedData as Record<string, unknown>) };
            delete sanitizedLoadedData.pluginStorage;

            const { llmProviders, storage, ...otherSettings } = sanitizedLoadedData;
            Object.assign(this.settings, otherSettings);

            // Ensure memory settings exist
            this.settings.memory = DEFAULT_SETTINGS.memory;

            // Deep merge storage settings to preserve defaults for missing keys
            if (storage && typeof storage === 'object') {
                this.settings.storage = {
                    ...DEFAULT_SETTINGS.storage,
                    ...(storage as Record<string, unknown>)
                } as typeof DEFAULT_SETTINGS.storage;
            }

            // Basic LLM provider settings merge
            if (llmProviders && typeof llmProviders === 'object' && DEFAULT_SETTINGS.llmProviders) {
                const loadedProviders = llmProviders as Record<string, unknown> & {
                    providers?: Record<string, LLMProviderConfig>;
                };
                this.settings.llmProviders = {
                    ...DEFAULT_SETTINGS.llmProviders,
                    ...loadedProviders,
                    // Ensure providers exists with all default providers
                    providers: {
                        ...DEFAULT_SETTINGS.llmProviders.providers,
                        ...(loadedProviders.providers || {})
                    }
                };
            }
        } catch {
            // Continue with defaults - plugin should still function
        }
    }

    /**
     * Save settings to plugin data
     */
    async saveSettings(): Promise<void> {
        await pluginDataLock.acquire(async () => {
            const loadedData: unknown = await this.plugin.loadData();
            // Move secrets into app.secretStorage and persist a clone with the
            // secret fields blanked, but only when the user has opted in. When
            // the option is off (or secretStorage is unavailable) the original
            // settings are persisted unchanged (plaintext fallback).
            const { settings: persistableSettings } = this.settings.secureApiKeyStorage
                ? stripSecretsForPersist(this.settings, this.secretStore)
                : { settings: this.settings };
            const settingsWithoutRuntimeState = {
                ...(persistableSettings as MCPSettings & { pluginStorage?: unknown })
            };
            delete settingsWithoutRuntimeState.pluginStorage;
            const mergedData = loadedData && typeof loadedData === 'object'
                ? { ...(loadedData as Record<string, unknown>), ...settingsWithoutRuntimeState }
                : settingsWithoutRuntimeState;

            await this.plugin.saveData(mergedData);
        });
    }

    /**
     * Whether Obsidian's secretStorage API is available (requires Obsidian
     * 1.11.4+). Gates whether the secure-key-storage option can be enabled.
     */
    isSecretStorageAvailable(): boolean {
        return this.secretStore.isAvailable();
    }

    /**
     * Turn the secure-key-storage option on or off and migrate accordingly.
     * Enabling persists the in-memory keys into secretStorage and strips them
     * from data.json. Disabling persists the in-memory plaintext back into
     * data.json (so keys sync again) and then clears the stored copies. An
     * enable request is ignored when secretStorage is unavailable.
     */
    async setSecureApiKeyStorage(enabled: boolean): Promise<void> {
        if (enabled && !this.secretStore.isAvailable()) {
            return;
        }
        this.settings.secureApiKeyStorage = enabled;
        await this.saveSettings();
        if (!enabled) {
            clearStoredSecrets(this.settings, this.secretStore);
        }
    }
}

// Re-export types and constants from types.ts
export type { MCPSettings };
export { DEFAULT_SETTINGS };
