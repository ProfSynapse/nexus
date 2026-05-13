/**
 * Location: /src/core/background/BackgroundProcessor.ts
 * 
 * Background Processor - Handles background tasks, startup processing, and validation
 * 
 * This service extracts background processing logic from PluginLifecycleManager,
 * managing deferred operations and non-critical startup tasks.
 */

import type { Plugin } from 'obsidian';
import type { ServiceManager } from '../ServiceManager';
import type { Settings } from '../../settings';
import type { SettingsView } from '../../settings/SettingsView';

export interface BackgroundProcessorConfig {
    plugin: Plugin;
    settings: Settings;
    serviceManager: ServiceManager;
    settingsTab?: SettingsView;
    getService: <T>(name: string, timeoutMs?: number) => Promise<T | null>;
    waitForService: <T>(serviceName: string, timeoutMs?: number) => Promise<T | null>;
    isInitialized: () => boolean;
}

export class BackgroundProcessor {
    private config: BackgroundProcessorConfig;
    private hasRunBackgroundStartup = false;

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
        setTimeout(() => {
            void this.runBackgroundStartup();
        }, 2000); // 2 second delay to ensure Obsidian is fully loaded
    }

    validateSearchFunctionality(): void {
        try {
            const serviceManager = this.config.serviceManager;
            if (serviceManager) {
                const metadata = serviceManager.getAllServiceStatus();
                const serviceNames = Object.keys(metadata);

                const coreServices = ['workspaceService', 'memoryService', 'chatService'];
                coreServices.filter(service => serviceNames.includes(service));
            }
        } catch (error) {
            console.error('Error validating search functionality:', error);
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

    private async runBackgroundStartup(): Promise<void> {
        try {
            // Double-check to prevent race conditions
            if (this.hasRunBackgroundStartup) {
                return;
            }

            this.hasRunBackgroundStartup = true;

            const workflowScheduleService = await this.config.getService<{ start: () => Promise<void> }>('workflowScheduleService');
            if (workflowScheduleService) {
                await workflowScheduleService.start();
            }
        } catch (error) {
            console.error('Error in background startup processing:', error);
            // Reset flag on error so it can be retried
            this.hasRunBackgroundStartup = false;
        }
    }

}
