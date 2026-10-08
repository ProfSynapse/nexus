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
    private startupTimer: number | null = null;
    private startupPromise: Promise<void> | null = null;
    private stopped = false;

    constructor(config: BackgroundProcessorConfig) {
        this.config = config;
    }

    /**
     * Start background startup processing - runs independently after plugin initialization
     */
    startBackgroundStartupProcessing(): void {
        // Prevent multiple background startup processes
        if (this.stopped || this.hasRunBackgroundStartup || this.startupTimer !== null) {
            return;
        }
        
        // Run startup processing in background without blocking plugin initialization
        this.startupTimer = window.setTimeout(() => {
            this.startupTimer = null;
            if (this.stopped) return;
            this.startupPromise = this.runBackgroundStartup().finally(() => {
                this.startupPromise = null;
            });
        }, 2000); // 2 second delay to ensure Obsidian is fully loaded
    }

    async shutdown(): Promise<void> {
        this.stopped = true;
        if (this.startupTimer !== null) {
            window.clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }
        await this.startupPromise;
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
            if (this.stopped || this.hasRunBackgroundStartup) {
                return;
            }

            this.hasRunBackgroundStartup = true;

            const remoteRegistry = await this.config.getService<{ start: () => void | Promise<void> }>('remoteAgentRegistry');
            if (this.stopped) return;
            const remoteJobs = await this.config.getService<{ start: () => Promise<void> }>('remoteAgentJobs');
            if (this.stopped) return;
            // Independent recovery services must not prevent workflow startup on a connection failure.
            await Promise.allSettled([remoteRegistry?.start(), remoteJobs?.start()]);
            if (this.stopped) return;

            const workflowScheduleService = await this.config.getService<{ start: () => Promise<void> }>('workflowScheduleService');
            if (this.stopped) return;
            if (workflowScheduleService) {
                await workflowScheduleService.start();
            }
        } catch (error) {
            if (this.stopped) return;
            console.error('Error in background startup processing:', error);
            // Reset flag on error so it can be retried
            this.hasRunBackgroundStartup = false;
        }
    }

}
