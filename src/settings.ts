import { Plugin } from 'obsidian';
import { MCPSettings, DEFAULT_SETTINGS, type LLMProviderConfig } from './types';
import { pluginDataLock } from './utils/pluginDataLock';
import { LLMSettingsNotifier } from './services/llm/LLMSettingsNotifier';
import { cloneSettings, mergeSettingsChanges, reconcileSettingsInPlace, settingsEqual } from './services/settings/SettingsMerge';
import { SecretStore } from './services/secrets/SecretStore';
import { normalizeInstructionLibrarySettings } from './services/instructions/InstructionMetadataService';
import {
    clearStoredSecrets,
    hydrateSecrets,
    migrateLegacyPlaintext,
    stripSecretsForPersist
} from './services/secrets/SettingsSecrets';

/** Assign an optional key, removing it rather than storing an explicit undefined. */
function setOptionalKey<K extends keyof MCPSettings>(target: MCPSettings, key: K, value: MCPSettings[K]): void {
    if (value === undefined) {
        delete target[key];
    } else {
        target[key] = value;
    }
}

/**
 * Settings manager
 * Handles loading and saving plugin settings
 */
export class Settings {
    private plugin: Plugin;
    private secretStore: SecretStore;
    settings: MCPSettings;
    private baseline: MCPSettings;
    private loaded = false;

    /**
     * Create a new settings manager
     * @param plugin Plugin instance
     */
    constructor(plugin: Plugin) {
        this.plugin = plugin;
        this.secretStore = new SecretStore(plugin.app ?? {});
        this.settings = this.buildLoadedSettings(undefined);
        this.baseline = cloneSettings(this.settings);
    }

    /**
     * Load settings from plugin data
     * Now synchronous with minimal validation for fast startup
     */
    async loadSettings(): Promise<void> {
        try {
            const loadedData: unknown = await this.plugin.loadData();
            const plaintext = cloneSettings(loadedData && typeof loadedData === 'object' ? loadedData : {}) as MCPSettings;
            // Migrate actual plaintext before hydration, so ordinary startup
            // does not mistake every hydrated key for a legacy migration.
            const migrated = plaintext.secureApiKeyStorage
                ? migrateLegacyPlaintext(plaintext, this.secretStore)
                : false;
            const loaded = this.buildLoadedSettings(plaintext);
            this.hydrate(loaded);
            reconcileSettingsInPlace(this.settings, loaded);
            this.baseline = cloneSettings(loaded);
            this.loaded = true;
            if (migrated) await this.saveSettings();
        } catch {
            // Continue with defaults - plugin should still function
        }
    }
    
    /**
     * Apply loaded data with minimal validation for fast startup
     */
    private buildLoadedSettings(loadedData: unknown): MCPSettings {
        const settings = cloneSettings(DEFAULT_SETTINGS);
        settings.instructionLibrary = normalizeInstructionLibrarySettings(undefined);
        if (!loadedData || typeof loadedData !== 'object') return settings;
        
        // Quick shallow merge for startup - detailed validation deferred
        try {
            const sanitizedLoadedData = cloneSettings(loadedData as Record<string, unknown>);
            delete sanitizedLoadedData.pluginStorage;

            const { llmProviders, storage, ...otherSettings } = sanitizedLoadedData;
            Object.assign(settings, otherSettings);
            settings.instructionLibrary = normalizeInstructionLibrarySettings(otherSettings.instructionLibrary);

            // Ensure memory settings exist
            settings.memory = cloneSettings(DEFAULT_SETTINGS.memory);

            // Deep merge storage settings to preserve defaults for missing keys
            if (storage && typeof storage === 'object') {
                settings.storage = {
                    ...settings.storage,
                    ...(storage as Record<string, unknown>)
                } as typeof DEFAULT_SETTINGS.storage;
            }

            // Basic LLM provider settings merge
            const defaultProviderSettings = settings.llmProviders;
            if (llmProviders && typeof llmProviders === 'object' && defaultProviderSettings) {
                const loadedProviders = llmProviders as Record<string, unknown> & {
                    providers?: Record<string, LLMProviderConfig>;
                };
                const providers = { ...defaultProviderSettings.providers };
                for (const [id, config] of Object.entries(loadedProviders.providers || {})) {
                    // Dirty-field saves can persist a partial builtin provider.
                    providers[id] = { ...providers[id], ...config };
                }
                settings.llmProviders = {
                    ...defaultProviderSettings,
                    ...loadedProviders,
                    // Ensure providers exists with all default providers
                    providers
                };
                this.migrateRetiredImageModel(settings);
            }
        } catch {
            // Continue with defaults - plugin should still function
        }
        return settings;
    }

    /**
     * gemini-2.5-flash-image shuts down on 2026-10-02. A saved default that
     * still names it would start failing on that date, so it moves to the
     * current Nano Banana 2 id, which both Google direct and OpenRouter serve.
     * The provider is kept.
     */
    private migrateRetiredImageModel(settings: MCPSettings): void {
        const llmProviders = settings.llmProviders;
        const selection = llmProviders?.defaultImageModel;
        if (llmProviders && selection?.model === 'gemini-2.5-flash-image') {
            llmProviders.defaultImageModel = {
                ...selection,
                model: 'gemini-3.1-flash-image'
            };
        }
    }

    /**
     * Save settings to plugin data
     */
    async saveSettings(): Promise<void> {
        await pluginDataLock.acquire(async () => {
            const local = cloneSettings(this.settings);
            delete local.pluginStorage;
            const loadedData: unknown = await this.plugin.loadData();
            const latest = this.readIncoming(loadedData);
            const merged = mergeSettingsChanges(this.baseline, local, latest);
            // Hydrate incoming settings before merging, then strip the merged
            // values. Unchanged stale runtime secrets never overwrite the store.
            const persistable = merged.secureApiKeyStorage
                ? stripSecretsForPersist(merged, this.secretStore).settings
                : cloneSettings(merged);
            delete persistable.pluginStorage;
            const persisted = { ...persistable };
            if (loadedData && typeof loadedData === 'object' && 'pluginStorage' in loadedData) {
                persisted.pluginStorage = (loadedData as MCPSettings).pluginStorage;
            }
            await this.plugin.saveData(persisted);
            if (latest.secureApiKeyStorage && !merged.secureApiKeyStorage) {
                clearStoredSecrets(merged, this.secretStore);
            }
            // Edits made while disk I/O was pending remain dirty for the next save.
            const committedRuntime = cloneSettings(local);
            committedRuntime.llmProviders = this.buildLoadedSettings(merged).llmProviders;
            const next = mergeSettingsChanges(local, cloneSettings(this.settings), committedRuntime);
            delete next.pluginStorage;
            this.baseline = committedRuntime;
            this.loaded = true;
            this.adoptSettings(next);
        });
    }

    /**
     * Refresh live providers and the semantic search switch; storage roots and
     * other service configuration require reload. Returns whether a reload is
     * needed. A synced `enableEmbeddings` change is adopted here and applied by
     * the plugin at runtime (see NexusPlugin.onExternalSettingsChange), so it
     * never asks for a reload.
     */
    async reconcileExternalSettings(signal?: AbortSignal): Promise<boolean> {
        if (!this.loaded || signal?.aborted) return false;
        return pluginDataLock.acquire(async () => {
            if (signal?.aborted) return false;
            const loadedData: unknown = await this.plugin.loadData();
            if (signal?.aborted) return false;
            return this.reconcileProviders(this.readIncoming(loadedData));
        });
    }

    private reconcileProviders(incoming: MCPSettings): boolean {
        const normalized = this.buildLoadedSettings(incoming);
        const merged = mergeSettingsChanges(this.baseline, cloneSettings(this.settings), normalized);
        const next = cloneSettings(this.settings);
        next.llmProviders = merged.llmProviders;
        setOptionalKey(next, 'enableEmbeddings', merged.enableEmbeddings);
        const requiresReload = !settingsEqual(this.reloadSettings(this.baseline), this.reloadSettings(normalized));
        this.baseline.llmProviders = cloneSettings(normalized.llmProviders);
        setOptionalKey(this.baseline, 'enableEmbeddings', normalized.enableEmbeddings);
        this.adoptSettings(next);
        return requiresReload;
    }

    private readIncoming(loadedData: unknown): MCPSettings {
        const incoming = cloneSettings(loadedData && typeof loadedData === 'object' ? loadedData : {}) as MCPSettings;
        delete incoming.pluginStorage;
        this.hydrate(incoming);
        return incoming;
    }

    /** The settings whose synced change needs a reload: everything not applied live. */
    private reloadSettings(settings: MCPSettings): Omit<MCPSettings, 'llmProviders' | 'workflowScheduler' | 'pluginStorage' | 'enableEmbeddings'> {
        const other = cloneSettings(settings);
        delete other.llmProviders;
        delete other.workflowScheduler;
        delete other.pluginStorage;
        delete other.enableEmbeddings;
        return other;
    }

    private hydrate(settings: MCPSettings): void {
        if (settings.secureApiKeyStorage) hydrateSecrets(settings, this.secretStore);
    }

    private adoptSettings(next: MCPSettings): void {
        const providersChanged = !settingsEqual(this.settings.llmProviders, next.llmProviders);
        reconcileSettingsInPlace(this.settings, next);
        if (providersChanged && this.settings.llmProviders) LLMSettingsNotifier.notify(this.settings.llmProviders);
    }

    /** Persist only the scheduler watermark; a background tick must not upload stale provider settings. */
    async saveWorkflowSchedulerState(lastCheckAt: number, signal?: AbortSignal): Promise<void> {
        await pluginDataLock.acquire(async () => {
            if (signal?.aborted) return;
            const loadedData: unknown = await this.plugin.loadData();
            if (signal?.aborted) return;
            const persisted = loadedData && typeof loadedData === 'object'
                ? loadedData as Record<string, unknown>
                : {};
            const scheduler = persisted.workflowScheduler && typeof persisted.workflowScheduler === 'object'
                ? persisted.workflowScheduler as Record<string, unknown>
                : {};
            const previousCheck = scheduler.lastCheckAt;
            const nextCheck = typeof previousCheck === 'number' ? Math.max(previousCheck, lastCheckAt) : lastCheckAt;
            if (nextCheck !== previousCheck) {
                await this.plugin.saveData({ ...persisted, workflowScheduler: { ...scheduler, lastCheckAt: nextCheck } });
            }
            if (signal?.aborted) return;
            // loadData can acknowledge Obsidian's external-change timestamp.
            // Reconcile providers here too, in case this read precedes its callback.
            this.reconcileProviders(this.readIncoming(loadedData));
            this.settings.workflowScheduler = { ...this.settings.workflowScheduler, lastCheckAt: nextCheck };
            this.baseline.workflowScheduler = { ...this.baseline.workflowScheduler, lastCheckAt: nextCheck };
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
    }
}

// Re-export types and constants from types.ts
export type { MCPSettings };
export { DEFAULT_SETTINGS };
