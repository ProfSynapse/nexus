import { Plugin } from 'obsidian';
import { MCPSettings, DEFAULT_SETTINGS, type LLMProviderConfig } from './types';
import { pluginDataLock } from './utils/pluginDataLock';
import { SecretStore, type SecretStorageHost } from './services/secrets/SecretStore';
import {
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
            hydrateSecrets(this.settings, this.secretStore);
            if (migrateLegacyPlaintext(this.settings, this.secretStore)) {
                await this.saveSettings();
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
            // secret fields blanked. When secretStorage is unavailable this
            // returns the original settings unchanged (plaintext fallback).
            const { settings: persistableSettings } = stripSecretsForPersist(
                this.settings,
                this.secretStore
            );
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
}

// Re-export types and constants from types.ts
export type { MCPSettings };
export { DEFAULT_SETTINGS };
