/**
 * Location: /src/core/background/BackgroundProcessor.ts
 * 
 * Background Processor - Handles background tasks, startup processing, and validation
 * 
 * This service extracts background processing logic from PluginLifecycleManager,
 * managing deferred operations and non-critical startup tasks.
 */

import { Notice } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { Settings } from '../../settings';
import type { SettingsView } from '../../settings/SettingsView';
import { UpdateManager } from '../../utils/UpdateManager';

export interface BackgroundProcessorConfig {
    plugin: Plugin;
    settings: Settings;
    serviceManager: any;
    settingsTab?: SettingsView;
    getService: <T>(name: string, timeoutMs?: number) => Promise<T | null>;
    waitForService: <T>(serviceName: string, timeoutMs?: number) => Promise<T | null>;
    isInitialized: () => boolean;
}

export class BackgroundProcessor {
    private config: BackgroundProcessorConfig;
    private hasRunBackgroundStartup: boolean = false;

    constructor(config: BackgroundProcessorConfig) {
        this.config = config;
    }

    /**
     * Start background startup processing - runs independently after plugin initialization
     */
    startBackgroundStartupProcessing(): void {
        // Prevent multiple background startup processes
        if (this.hasRunBackgroundStartup) {
            return;
        }
        
        // Run startup processing in background without blocking plugin initialization
        setTimeout(async () => {
            try {
                // Double-check to prevent race conditions
                if (this.hasRunBackgroundStartup) {
                    return;
                }
                
                this.hasRunBackgroundStartup = true;

                // Background startup processing completed
            } catch (error) {
                console.error('Error in background startup processing:', error);
                // Reset flag on error so it can be retried
                this.hasRunBackgroundStartup = false;
            }
        }, 2000); // 2 second delay to ensure Obsidian is fully loaded
    }

    /**
     * Check for updates on startup in background
     */
    async checkForUpdatesOnStartup(): Promise<void> {
        // Run in background to avoid blocking startup
        setTimeout(async () => {
            try {
                const { settings } = this.config;
                const lastCheck = settings.settings.lastUpdateCheckDate;
                if (lastCheck) {
                    const lastCheckTime = new Date(lastCheck);
                    const now = new Date();
                    const daysDiff = (now.getTime() - lastCheckTime.getTime()) / (1000 * 60 * 60 * 24);
                    if (daysDiff < 1) {
                        return;
                    }
                }

                const updateManager = new UpdateManager(this.config.plugin);
                const hasUpdate = await updateManager.checkForUpdate();

                settings.settings.lastUpdateCheckDate = new Date().toISOString();

                if (hasUpdate) {
                    const availableVersion = await updateManager.getLatestVersion();

                    settings.settings.availableUpdateVersion = availableVersion;

                    new Notice(`Plugin update available: v${availableVersion}. Check settings to update.`, 8000);
                } else {
                    settings.settings.availableUpdateVersion = undefined;
                }

                await settings.saveSettings();

            } catch (error) {
                console.error('Failed to check for updates:', error);
            }
        }, 2000); // 2 second delay
    }

    async validateSearchFunctionality(): Promise<void> {
        try {
            const serviceManager = this.config.serviceManager;
            if (serviceManager) {
                const metadata = serviceManager.getAllServiceStatus();
                const serviceNames = Object.keys(metadata);

                const coreServices = ['workspaceService', 'memoryService', 'chatService'];
                const availableCore = coreServices.filter(service => serviceNames.includes(service));
            }
        } catch (error) {
        }
    }

    /**
     * Update settings tab with available services (non-blocking)
     */
    updateSettingsTabServices(): void {
        if (this.config.settingsTab) {
            const services: Record<string, unknown> = {};
            for (const serviceName of this.config.serviceManager.getReadyServices()) {
                services[serviceName] = this.config.serviceManager.getServiceIfReady(serviceName);
            }
            this.config.settingsTab.updateServices(services);
        }
    }

    /**
     * Update settings tab reference (used when settings tab is created)
     */
    setSettingsTab(settingsTab: SettingsView): void {
        this.config.settingsTab = settingsTab;
    }

    /**
     * Check if background startup processing has run
     */
    hasRunBackgroundStartupProcessing(): boolean {
        return this.hasRunBackgroundStartup;
    }

    /**
     * Reset background startup flag (useful for testing)
     */
    resetBackgroundStartupFlag(): void {
        this.hasRunBackgroundStartup = false;
    }
}