import { Plugin } from 'obsidian';
import { MCPSettings, DEFAULT_SETTINGS, type LLMProviderConfig } from './types';

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
        
        // Start with default settings (includes memory)
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        
        // Quick shallow merge for startup - detailed validation deferred
        try {
            const { llmProviders, ...otherSettings } = loadedData as Record<string, unknown>;
            Object.assign(this.settings, otherSettings);
            
            // Ensure memory settings exist
            this.settings.memory = DEFAULT_SETTINGS.memory;

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
        // Simple JSON-based storage
        await this.plugin.saveData(this.settings);
    }
}

// Re-export types and constants from types.ts
export type { MCPSettings };
export { DEFAULT_SETTINGS };
