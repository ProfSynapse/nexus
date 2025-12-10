/**
 * Location: /src/core/settings/SettingsTabManager.ts
 * 
 * Settings Tab Manager - Handles settings tab creation and management
 * 
 * This service extracts settings tab management from PluginLifecycleManager,
 * providing focused settings tab lifecycle management.
 */

import type { Plugin } from 'obsidian';
import type { Settings } from '../../settings';
// Use new SettingsView (tab-based UI) instead of old SettingsTab (accordion-based)
import { SettingsView } from '../../settings/SettingsView';
import type { BackgroundProcessor } from '../background/BackgroundProcessor';

// Type-only import to avoid bundling Node.js dependencies on mobile
type MCPConnectorType = import('../../connector').MCPConnector;

export interface SettingsTabManagerConfig {
    plugin: Plugin;
    app: any;
    settings: Settings;
    serviceManager: any;
    connector?: MCPConnectorType; // Optional - undefined on mobile
    lifecycleManager: any; // Reference to PluginLifecycleManager for ChatView activation
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
    async initializeSettingsTab(): Promise<void> {
        try {
            // Get agent references - may not be available yet
            const vaultLibrarian = this.config.connector?.getVaultLibrarian();
            const memoryManager = this.config.connector?.getMemoryManager();
            
            // Get services from container
            const services: Record<string, any> = {};
            for (const serviceName of this.config.serviceManager.getReadyServices()) {
                services[serviceName] = this.config.serviceManager.getServiceIfReady(serviceName);
            }
            
            // Create settings tab with current state (using new tab-based SettingsView)
            this.settingsTab = new SettingsView(
                this.config.app,
                this.config.plugin,
                this.config.settings,
                services, // Pass current services (may be empty initially)
                vaultLibrarian || undefined,
                memoryManager || undefined,
                this.config.serviceManager as any, // Pass service manager for compatibility
                this.config.lifecycleManager // Pass lifecycle manager for ChatView activation
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
     * Check if settings tab is initialized
     */
    isInitialized(): boolean {
        return !!this.settingsTab;
    }

    /**
     * Cleanup settings tab (called during shutdown)
     */
    cleanup(): void {
        if (this.settingsTab && typeof (this.settingsTab as any).cleanup === 'function') {
            (this.settingsTab as any).cleanup();
        }
    }
}