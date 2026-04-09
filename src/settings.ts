import { Plugin } from 'obsidian';
import {
    MCPSettings,
    DEFAULT_SETTINGS,
    DEFAULT_STORAGE_SETTINGS,
    type LLMProviderConfig,
    type MCPStorageSettings
} from './types';
import { pluginDataLock } from './utils/pluginDataLock';

function mergeStorageSettings(
    defaults: MCPStorageSettings,
    storage: Record<string, unknown> | undefined
): MCPStorageSettings {
    const merged: MCPStorageSettings = {
        ...defaults
    };

    if (typeof storage?.schemaVersion === 'number' && Number.isFinite(storage.schemaVersion)) {
        merged.schemaVersion = storage.schemaVersion;
    }

    if (typeof storage?.rootPath === 'string' && storage.rootPath.trim().length > 0) {
        merged.rootPath = storage.rootPath;
    }

    if (typeof storage?.maxShardBytes === 'number' && Number.isFinite(storage.maxShardBytes) && storage.maxShardBytes > 0) {
        merged.maxShardBytes = Math.floor(storage.maxShardBytes);
    }

    return merged;
}

/**
 * Settings manager
 * Handles loading and saving plugin settings
 */
export class Settings {
    private plugin: Plugin;
    settings: MCPSettings;

    /**
     * Create a new settings manager
     * @param plugin Plugin instance
     */
    constructor(plugin: Plugin) {
        this.plugin = plugin;
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

        // Start with default settings (includes storage)
        this.settings = Object.assign({}, DEFAULT_SETTINGS);

        // Quick shallow merge for startup - detailed validation deferred
        try {
            const { llmProviders, storage, ...otherSettings } = loadedData as Record<string, unknown>;
            Object.assign(this.settings, otherSettings);

            // Ensure memory settings exist
            this.settings.memory = DEFAULT_SETTINGS.memory;

            // Merge storage settings with nested defaults
            if (storage && typeof storage === 'object' && DEFAULT_SETTINGS.storage) {
                this.settings.storage = mergeStorageSettings(DEFAULT_SETTINGS.storage, storage as Record<string, unknown>);
            } else {
                this.settings.storage = mergeStorageSettings(DEFAULT_STORAGE_SETTINGS, undefined);
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
            const mergedData = loadedData && typeof loadedData === 'object'
                ? { ...(loadedData as Record<string, unknown>), ...this.settings }
                : this.settings;

            await this.plugin.saveData(mergedData);
        });
    }
}

// Re-export types and constants from types.ts
export type { MCPSettings };
export { DEFAULT_SETTINGS };
