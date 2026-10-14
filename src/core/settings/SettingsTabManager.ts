/**
 * Location: /src/core/settings/SettingsTabManager.ts
 * 
 * Settings Tab Manager - Handles settings tab creation and management
 * 
 * This service extracts settings tab management from PluginLifecycleManager,
 * providing focused settings tab lifecycle management.
 */

import type { App, Plugin } from 'obsidian';
import type { Settings } from '../../settings';
// Use new SettingsView (tab-based UI) instead of old SettingsTab (accordion-based)
import { SettingsView } from '../../settings/SettingsView';
import type { RouterState } from '../../settings/SettingsRouter';
import type { BackgroundProcessor } from '../background/BackgroundProcessor';
import type { PluginLifecycleManager } from '../PluginLifecycleManager';
import type { ServiceManager } from '../ServiceManager';

// Type-only import to avoid bundling Node.js dependencies on mobile
type MCPConnectorType = import('../../connector').MCPConnector;

/** Obsidian's settings modal is not part of the public App typings. */
interface AppWithSettingModal {
    setting?: {
        open(): void;
        openTabById(id: string): void;
    };
}

export interface SettingsTabManagerConfig {
    plugin: Plugin;
    app: App;
    settings: Settings;
    serviceManager: ServiceManager;
    connector?: MCPConnectorType; // Optional - undefined on mobile
    lifecycleManager: PluginLifecycleManager; // Reference to PluginLifecycleManager for ChatView activation
    backgroundProcessor?: BackgroundProcessor;
}

export class SettingsTabManager {
    private config: SettingsTabManagerConfig;
    private settingsTab?: SettingsView;

    constructor(config: SettingsTabManagerConfig) {
        this.config = config;
    }

    /**
     * Initialize settings tab asynchronously
     */
    initializeSettingsTab(): void {
        try {
            // Get agent references - may not be available yet
            const searchManager = this.config.connector?.getSearchManager();
            const memoryManager = this.config.connector?.getMemoryManager();
            const appManager = this.config.connector?.getAppManager();

            // Get services from container
            const services: Record<string, unknown> = {};
            for (const serviceName of this.config.serviceManager.getReadyServices()) {
                services[serviceName] = this.config.serviceManager.getServiceIfReady(serviceName);
            }

            // Create settings tab with current state (using new tab-based SettingsView)
            this.settingsTab = new SettingsView(
                this.config.app,
                this.config.plugin,
                this.config.settings,
                services, // Pass current services (may be empty initially)
                searchManager || undefined,
                memoryManager || undefined,
                this.config.serviceManager, // Pass service manager for compatibility
                this.config.lifecycleManager, // Pass lifecycle manager for ChatView activation
                appManager || undefined
            );
            this.config.plugin.addSettingTab(this.settingsTab);
            
            // Pass settings tab to background processor for service updates
            if (this.config.backgroundProcessor) {
                this.config.backgroundProcessor.setSettingsTab(this.settingsTab);
            }
            
        } catch (error) {
            console.error('[SettingsTabManager] Settings tab initialization failed:', error);
            // Plugin should still function without settings tab
        }
    }

    /**
     * Set background processor reference (used for dependency injection)
     */
    setBackgroundProcessor(backgroundProcessor: BackgroundProcessor): void {
        this.config.backgroundProcessor = backgroundProcessor;
        
        // Pass settings tab if already created
        if (this.settingsTab && backgroundProcessor) {
            backgroundProcessor.setSettingsTab(this.settingsTab);
        }
    }

    /**
     * Get the settings tab instance
     */
    getSettingsTab(): SettingsView | undefined {
        return this.settingsTab;
    }

    /**
     * Open Settings on the Nexus tab, at the requested route (for example the
     * Providers tab). Returns false when Obsidian's settings modal is unavailable.
     */
    openNexusSettings(route: Partial<RouterState>): boolean {
        const setting = (this.config.app as unknown as AppWithSettingModal).setting;
        if (!setting) return false;
        this.settingsTab?.openTo(route);
        setting.open();
        setting.openTabById(this.config.plugin.manifest.id);
        return true;
    }

    /**
     * Check if settings tab is initialized
     */
    isInitialized(): boolean {
        return !!this.settingsTab;
    }

    /**
     * Cleanup settings tab (called during shutdown)
     */
    cleanup(): void {
        if (this.settingsTab && 'cleanup' in this.settingsTab && typeof this.settingsTab.cleanup === 'function') {
            this.settingsTab.cleanup();
        }
    }
}