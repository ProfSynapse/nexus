import { Plugin } from 'obsidian';
import { MCPSettings, DEFAULT_SETTINGS } from './types';

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
    async loadSettings() {
        try {
            const loadedData = await this.plugin.loadData();
            this.applyLoadedData(loadedData);
        } catch (error) {
            // Continue with defaults - plugin should still function
        }
    }
    
    /**
     * Apply loaded data with minimal validation for fast startup
     */
    private applyLoadedData(loadedData: any) {
        if (!loadedData) {
            return; // Use defaults
        }
        
        // Start with default settings (includes memory)
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        
        // Quick shallow merge for startup - detailed validation deferred
        try {
            const { memory, llmProviders, ...otherSettings } = loadedData;
            Object.assign(this.settings, otherSettings);
            
            // Ensure memory settings exist
            this.settings.memory = DEFAULT_SETTINGS.memory;

            // Basic LLM provider settings merge
            if (llmProviders && DEFAULT_SETTINGS.llmProviders) {
                this.settings.llmProviders = {
                    ...DEFAULT_SETTINGS.llmProviders,
                    ...llmProviders,
                    // Ensure providers exists with all default providers
                    providers: {
                        ...DEFAULT_SETTINGS.llmProviders.providers,
                        ...(llmProviders.providers || {})
                    }
                };
            }
        } catch (error) {
            // Continue with defaults - plugin should still function
        }
    }

    /**
     * Save settings to plugin data
     */
    async saveSettings() {
        // Simple JSON-based storage
        await this.plugin.saveData(this.settings);
    }
}

// Re-export types and constants from types.ts
export type { MCPSettings };
export { DEFAULT_SETTINGS };