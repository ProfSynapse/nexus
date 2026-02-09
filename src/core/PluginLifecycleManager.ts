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
import { InlineEditCommandManager } from './commands/InlineEditCommandManager';
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

/**
 * Extended Plugin interface with required service methods
 * Used for proper typing when passing plugin to child managers
 */
interface PluginWithServices extends Plugin {
    settings?: Settings;
    getService<T>(name: string, timeoutMs?: number): Promise<T | null>;
    embeddingManager?: EmbeddingManager;
}

/**
 * Type guard to check if a Plugin has the required service methods
 */
function isPluginWithServices(plugin: Plugin): plugin is PluginWithServices {
    return typeof (plugin as PluginWithServices).getService === 'function';
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
    private inlineEditCommandManager: InlineEditCommandManager;
    private embeddingManager: EmbeddingManager | null = null;

    // Pending timer handles for cleanup on shutdown
    private pendingTimers: ReturnType<typeof setTimeout>[] = [];

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

        // Create inline edit command manager
        // The plugin is guaranteed to have getService method by main.ts initialization
        if (!isPluginWithServices(config.plugin)) {
            throw new Error('Plugin must implement getService method for InlineEditCommandManager');
        }
        this.inlineEditCommandManager = new InlineEditCommandManager({
            plugin: config.plugin,
            app: config.app,
            getService: (name, timeoutMs) => this.serviceRegistrar.getService(name, timeoutMs)
        });
    }

    /**
     * Initialize plugin - called from onload()
     */
    async initialize(): Promise<void> {
        try {
            // PHASE 1: Foundation - Service container and settings already created by main.ts

            // PHASE 2: Register core services (no initialization yet)
            await this.serviceRegistrar.registerCoreServices();

            // PHASE 3: Register ChatView EARLY so Obsidian can restore it during layout restoration
            // The view will show a loading state until chatService becomes available
            await this.chatUIManager.registerViewEarly();

            // PHASE 4: Start background initialization immediately via setTimeout(0)
            // This yields back to Obsidian's event loop so onload() returns quickly,
            // but does NOT wait for onLayoutReady (which can take 13+ seconds).
            // ChatView handles null chatService gracefully with a loading spinner.
            const bgInitTimer = setTimeout(() => {
                this.startBackgroundInitialization().catch(error => {
                    console.error('[PluginLifecycleManager] Background initialization failed:', error);
                });
            }, 0);
            this.pendingTimers.push(bgInitTimer);

        } catch (error) {
            console.error('[PluginLifecycleManager] Critical initialization failure:', error);
            this.enableFallbackMode();
        }
    }

    /**
     * Background initialization - runs after onload() completes
     */
    private async startBackgroundInitialization(): Promise<void> {
        try {
            // Load settings first
            await this.config.settings.loadSettings();

            // Initialize data directories
            await this.serviceRegistrar.initializeDataDirectories();

            // Initialize services directly - no delay needed since they only take ~10ms
            // Previously gated behind setTimeout(1000) but diagnostics showed services are fast

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
                    // MCP connector start failed - non-fatal
                }
            }

            // Initialize ChatService AFTER agents are registered (so tools are available)
            try {
                await this.serviceRegistrar.initializeChatService();
            } catch (error) {
                console.error('[PluginLifecycleManager] ChatService init failed:', error);
            }

            // Register chat UI components AFTER ChatService is initialized
            await this.chatUIManager.registerChatUI();

            // Initialize settings tab AFTER business services are ready
            // This prevents race condition where settings tab tries to access agents before services are initialized
            await this.settingsTabManager.initializeSettingsTab();

            // Defer SQLite/embedding initialization - WASM loading is CPU-intensive (~2s)
            // Uses a fixed timeout from onload rather than onLayoutReady (which is unreliable, can take 13+s)
            // 3 second delay gives Obsidian enough time to finish loading screen
            if (!Platform.isMobile) {
                const sqliteTimer = setTimeout(async () => {
                    try {
                        const adapter = await this.config.serviceManager?.getService<HybridStorageAdapter>('hybridStorageAdapter');
                        if (adapter) {
                            await this.initializeEmbeddingsWhenReady(adapter);
                        }
                    } catch (err) {
                        console.error('[PluginLifecycleManager] Background SQLite initialization failed:', err);
                    }
                }, 3000); // 3s from background init start - Obsidian loading screen is gone by then
                this.pendingTimers.push(sqliteTimer);
            }

            // Register all maintenance commands
            this.commandManager.registerMaintenanceCommands();

            // Register inline edit commands and context menu
            this.inlineEditCommandManager.registerCommands();

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
     * Initialize embeddings when storage adapter becomes ready (called from background).
     * The storageAdapter.cache getter always returns the constructor-created sqliteCache,
     * so no waitForReady guard is needed here.
     */
    private async initializeEmbeddingsWhenReady(storageAdapter: HybridStorageAdapter): Promise<void> {
        try {
            const enableEmbeddings = this.config.settings.settings.enableEmbeddings ?? true;
            this.embeddingManager = new EmbeddingManager(
                this.config.app,
                this.config.plugin,
                storageAdapter.cache,
                enableEmbeddings,
                storageAdapter.messages
            );
            await this.embeddingManager.initialize();
            (this.config.plugin as PluginWithServices).embeddingManager = this.embeddingManager;

            // Wire embedding service into ChatTraceService
            const embeddingService = this.embeddingManager.getService();
            if (embeddingService) {
                const chatTraceService = await this.serviceRegistrar.getService<ChatTraceService>('chatTraceService');
                if (chatTraceService && typeof chatTraceService.setEmbeddingService === 'function') {
                    chatTraceService.setEmbeddingService(embeddingService);
                }
            }
        } catch (error) {
            console.error('[PluginLifecycleManager] Background embedding initialization failed:', error);
        }
    }

    /**
     * Shutdown and cleanup
     */
    async shutdown(): Promise<void> {
        try {
            // Cancel any pending timers that haven't fired yet
            for (const timer of this.pendingTimers) {
                clearTimeout(timer);
            }
            this.pendingTimers = [];

            // Clean up ServiceRegistrar's pending timers
            this.serviceRegistrar.shutdown();

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
