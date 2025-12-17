/**
 * Location: /src/core/PluginLifecycleManager.ts
 *
 * Plugin Lifecycle Manager - Handles plugin initialization, startup, and shutdown logic
 *
 * This service extracts complex lifecycle management from the main plugin class,
 * coordinating service initialization, background tasks, and cleanup procedures.
 * Used by main.ts to manage the plugin's lifecycle phases in a structured way.
 */

import { Plugin, Notice, Platform, App, PluginManifest } from 'obsidian';
import { ServiceManager } from './ServiceManager';
import { Settings } from '../settings';
import { UpdateManager } from '../utils/UpdateManager';
import { ServiceRegistrar } from './services/ServiceRegistrar';
import { MaintenanceCommandManager } from './commands/MaintenanceCommandManager';
import { ChatUIManager } from './ui/ChatUIManager';
import { BackgroundProcessor } from './background/BackgroundProcessor';
import { SettingsTabManager } from './settings/SettingsTabManager';
import { EmbeddingManager } from '../services/embeddings/EmbeddingManager';
import type { ServiceCreationContext } from './services/ServiceDefinitions';
import type { HybridStorageAdapter } from '../database/adapters/HybridStorageAdapter';
import type { ChatTraceService } from '../services/chat/ChatTraceService';

// Type-only import to avoid bundling Node.js dependencies on mobile
type MCPConnectorType = import('../connector').MCPConnector;

// Interface for services with storage state management
interface StateManager {
    saveState(): Promise<void>;
}

// Extended Plugin interface with optional embeddingManager property
interface PluginWithEmbedding extends Plugin {
    embeddingManager?: EmbeddingManager;
}

export interface PluginLifecycleConfig {
    plugin: Plugin;
    app: App;
    serviceManager: ServiceManager;
    settings: Settings;
    connector?: MCPConnectorType; // Optional - undefined on mobile
    manifest: PluginManifest;
}

/**
 * Plugin Lifecycle Manager - coordinates plugin initialization and shutdown
 */
export class PluginLifecycleManager {
    private config: PluginLifecycleConfig;
    private isInitialized: boolean = false;
    private startTime: number = Date.now();
    private serviceRegistrar: ServiceRegistrar;
    private commandManager: MaintenanceCommandManager;
    private chatUIManager: ChatUIManager;
    private backgroundProcessor: BackgroundProcessor;
    private settingsTabManager: SettingsTabManager;
    private embeddingManager: EmbeddingManager | null = null;

    constructor(config: PluginLifecycleConfig) {
        this.config = config;

        // Create service registrar with proper context
        const serviceContext: ServiceCreationContext = {
            plugin: config.plugin,
            app: config.app,
            serviceManager: config.serviceManager,
            settings: config.settings,
            connector: config.connector,
            manifest: config.manifest
        };
        this.serviceRegistrar = new ServiceRegistrar(serviceContext);

        // Create command manager
        this.commandManager = new MaintenanceCommandManager({
            plugin: config.plugin,
            serviceManager: config.serviceManager,
            getService: (name, timeoutMs) => this.serviceRegistrar.getService(name, timeoutMs),
            isInitialized: () => this.isInitialized
        });

        // Create chat UI manager
        this.chatUIManager = new ChatUIManager({
            plugin: config.plugin,
            app: config.app,
            settings: config.settings,
            getService: (name, timeoutMs) => this.serviceRegistrar.getService(name, timeoutMs)
        });

        // Create background processor
        this.backgroundProcessor = new BackgroundProcessor({
            plugin: config.plugin,
            settings: config.settings,
            serviceManager: config.serviceManager,
            getService: (name, timeoutMs) => this.serviceRegistrar.getService(name, timeoutMs),
            waitForService: (name, timeoutMs) => this.serviceRegistrar.waitForService(name, timeoutMs),
            isInitialized: () => this.isInitialized
        });

        // Create settings tab manager
        this.settingsTabManager = new SettingsTabManager({
            plugin: config.plugin,
            app: config.app,
            settings: config.settings,
            serviceManager: config.serviceManager,
            connector: config.connector,
            lifecycleManager: this,
            backgroundProcessor: this.backgroundProcessor
        });
    }

    /**
     * Initialize plugin - called from onload()
     */
    async initialize(): Promise<void> {
        const startTime = Date.now();

        try {
            // PHASE 1: Foundation - Service container and settings already created by main.ts

            // PHASE 2: Register core services (no initialization yet)
            await this.serviceRegistrar.registerCoreServices();

            // PHASE 3: Initialize essential services only
            await this.serviceRegistrar.initializeEssentialServices();

            // Plugin is now "loaded" - defer full initialization to background
            // PHASE 4: Start background initialization after onload completes
            setTimeout(() => {
                this.startBackgroundInitialization().catch(error => {
                    console.error('[PluginLifecycleManager] Background initialization failed:', error);
                });
            }, 0);

        } catch (error) {
            console.error('[PluginLifecycleManager] Critical initialization failure:', error);
            this.enableFallbackMode();
        }
    }

    /**
     * Background initialization - runs after onload() completes
     */
    private async startBackgroundInitialization(): Promise<void> {
        const bgStartTime = Date.now();

        try {
            // Load settings first
            await this.config.settings.loadSettings();

            // Initialize data directories
            await this.serviceRegistrar.initializeDataDirectories();

            // Now initialize heavy services in background (non-blocking)
            setTimeout(async () => {
                try {
                    // Initialize core services in proper dependency order
                    await this.serviceRegistrar.initializeBusinessServices();

                    // Pre-initialize UI-critical services to avoid long loading times
                    await this.serviceRegistrar.preInitializeUICriticalServices();

                    // Validate search functionality
                    await this.backgroundProcessor.validateSearchFunctionality();

                    // Start MCP server AFTER services are ready (registers agents)
                    // Only on desktop - connector is undefined on mobile
                    if (this.config.connector) {
                        try {
                            await this.config.connector.start();
                        } catch (error) {
                        }
                    }

                    // Initialize ChatService AFTER agents are registered (so tools are available)
                    try {
                        await this.serviceRegistrar.initializeChatService();
                    } catch (error) {
                    }

	                    // Register chat UI components AFTER ChatService is initialized
	                    await this.chatUIManager.registerChatUI();

	                    // Initialize embedding system (desktop only) after 3-second delay
	                    if (!Platform.isMobile) {
	                        setTimeout(async () => {
	                            try {
	                                const storageAdapter = await this.serviceRegistrar.getService<HybridStorageAdapter>('hybridStorageAdapter');
	                                if (storageAdapter && typeof storageAdapter.waitForReady === 'function') {
	                                    const ready = await storageAdapter.waitForReady();
	                                    if (!ready) {
	                                        return;
	                                    }
	                                }

	                                if (storageAdapter && storageAdapter.cache) {
	                                    this.embeddingManager = new EmbeddingManager(
	                                        this.config.app,
	                                        this.config.plugin,
	                                        storageAdapter.cache
	                                    );
	                                    await this.embeddingManager.initialize();
	                                    // Expose on plugin for lazy access by agents
	                                    (this.config.plugin as PluginWithEmbedding).embeddingManager = this.embeddingManager;

	                                    // Wire embedding service into ChatTraceService so new traces get embedded
	                                    const embeddingService = this.embeddingManager.getService();
	                                    if (embeddingService) {
	                                        const chatTraceService = await this.serviceRegistrar.getService<ChatTraceService>('chatTraceService');
	                                        if (chatTraceService && typeof chatTraceService.setEmbeddingService === 'function') {
	                                            chatTraceService.setEmbeddingService(embeddingService);
	                                        }
	                                    }
	                                }
	                            } catch (error) {
	                            }
	                        }, 3000);
	                    }
                } catch (error) {
                    console.error('[PluginLifecycleManager] Background service initialization failed:', error);
                }
            }, 100);

            // Create settings tab
            await this.settingsTabManager.initializeSettingsTab();

            // Register all maintenance commands
            this.commandManager.registerMaintenanceCommands();

            // Check for updates
            this.backgroundProcessor.checkForUpdatesOnStartup();

            // Update settings tab with loaded services
            this.backgroundProcessor.updateSettingsTabServices();

            // Mark as fully initialized
            this.isInitialized = true;

            // Start background startup processing after everything is ready
            this.backgroundProcessor.startBackgroundStartupProcessing();

        } catch (error) {
            console.error('[PluginLifecycleManager] Background initialization failed:', error);
        }
    }

    /**
     * Enable fallback mode with minimal functionality
     */
    private enableFallbackMode(): void {
        try {
            this.commandManager.registerTroubleshootCommand();
        } catch (error) {
            console.error('[PluginLifecycleManager] Fallback mode setup failed:', error);
        }
    }

    /**
     * Get service helper method
     */
    private async getService<T>(name: string, timeoutMs: number = 10000): Promise<T | null> {
        if (!this.config.serviceManager) {
            return null;
        }

        // Try to get service (will initialize if needed)
        try {
            return await this.config.serviceManager.getService<T>(name);
        } catch (error) {
            return null;
        }
    }

    /**
     * Reload configuration for all services after settings change
     */
    reloadConfiguration(): void {
        // Configuration reloading handled by individual services
    }

    /**
     * Get initialization status
     */
    getInitializationStatus(): { isInitialized: boolean; startTime: number } {
        return {
            isInitialized: this.isInitialized,
            startTime: this.startTime
        };
    }

    /**
     * Shutdown and cleanup
     */
    async shutdown(): Promise<void> {
        try {
            // Shutdown embedding system first (before database closes)
            if (this.embeddingManager) {
                try {
                    await this.embeddingManager.shutdown();
                } catch (error) {
                }
            }

            // Save processed files state before cleanup
            const stateManager = this.config.serviceManager?.getServiceIfReady<StateManager>('stateManager');
            if (stateManager && typeof stateManager.saveState === 'function') {
                await stateManager.saveState();
            }

            // Close HybridStorageAdapter to properly shut down SQLite
            const storageAdapter = this.config.serviceManager?.getServiceIfReady<HybridStorageAdapter>('hybridStorageAdapter');
            if (storageAdapter && typeof storageAdapter.close === 'function') {
                try {
                    await storageAdapter.close();
                } catch (error) {
                }
            }

            // Cleanup settings tab accordions
            this.settingsTabManager.cleanup();

            // Cleanup service manager (handles all service cleanup)
            if (this.config.serviceManager) {
                await this.config.serviceManager.stop();
            }

            // Stop the MCP connector
            if (this.config.connector) {
                await this.config.connector.stop();
            }

        } catch (error) {
            console.error('[PluginLifecycleManager] Error during cleanup:', error);
        }
    }
}
