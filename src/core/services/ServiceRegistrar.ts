/**
 * Location: /src/core/services/ServiceRegistrar.ts
 *
 * Service Registrar - Handles service registration and additional service factories
 *
 * This service extracts the complex service registration logic from PluginLifecycleManager,
 * making it data-driven and easily extensible for new services.
 */

import type { ServiceManager } from '../ServiceManager';
import { FileSystemService } from '../../services/storage/FileSystemService';
import { IndexManager } from '../../services/storage/IndexManager';
import { DataMigrationService } from '../../services/migration/DataMigrationService';
import { TraceSchemaMigrationService } from '../../services/migration/TraceSchemaMigrationService';
import { normalizePath } from 'obsidian';
import { CORE_SERVICE_DEFINITIONS, ADDITIONAL_SERVICE_FACTORIES } from './ServiceDefinitions';
import type { ServiceCreationContext, AdditionalServiceFactory } from './ServiceDefinitions';
import type { VaultOperations } from '../VaultOperations';
import type { ChatService } from '../../services/chat/ChatService';

export class ServiceRegistrar {
    private context: ServiceCreationContext;

    // Pending timer handle for deferred migration work
    private migrationTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(context: ServiceCreationContext) {
        this.context = context;
    }

    /**
     * Register all core services with the ServiceManager
     */
    async registerCoreServices(): Promise<void> {
        for (const serviceDef of CORE_SERVICE_DEFINITIONS) {
            await this.context.serviceManager.registerService({
                name: serviceDef.name,
                dependencies: serviceDef.dependencies,
                create: () => serviceDef.create(this.context)
            });
        }
    }

    /**
     * Register additional services needed by UI components using factory pattern
     */
    registerAdditionalServices(): void {
        const { serviceManager, plugin, settings, app } = this.context;

        // Early return if no additional service factories defined
        if (!ADDITIONAL_SERVICE_FACTORIES || ADDITIONAL_SERVICE_FACTORIES.length === 0) {
            return;
        }

        // Type guard to ensure service factory has required properties
        const isValidServiceFactory = (factory: unknown): factory is AdditionalServiceFactory => {
            if (factory === null || typeof factory !== 'object') {
                return false;
            }

            // At this point we know factory is a non-null object
            const obj = factory as Record<string, unknown>;

            return (
                'name' in obj &&
                'dependencies' in obj &&
                'factory' in obj &&
                typeof obj.name === 'string' &&
                Array.isArray(obj.dependencies) &&
                typeof obj.factory === 'function'
            );
        };

        for (const serviceFactory of ADDITIONAL_SERVICE_FACTORIES) {
            if (!isValidServiceFactory(serviceFactory)) {
                continue;
            }

            serviceManager.registerFactory(
                serviceFactory.name,
                async (deps) => {
                    // Create enhanced dependency context
                    const enhancedDeps = {
                        ...deps,
                        plugin,
                        app,
                        memorySettings: settings.settings.memory || {}
                    };
                    return serviceFactory.factory(enhancedDeps);
                },
                { dependencies: serviceFactory.dependencies }
            );
        }
    }

    /**
     * Get default memory settings
     */
    static getDefaultMemorySettings(dataDir: string) {
        return {};
    }

    /**
     * Initialize data directories and run migration if needed
     *
     * Heavy migration work is deferred to background to avoid blocking startup.
     */
    async initializeDataDirectories(): Promise<void> {
        try {
            const { app, plugin, settings, manifest, serviceManager } = this.context;

            // Get vaultOperations service with proper typing
            const vaultOperations = await serviceManager.getService<VaultOperations>('vaultOperations');

            // Initialize storage services (needed for directory creation)
            const fileSystem = new FileSystemService(plugin, vaultOperations);
            const indexManager = new IndexManager(fileSystem);

            // Legacy data directory handling - quick directory creation
            const pluginDir = `.obsidian/plugins/${manifest.id}`;
            const dataDir = `${pluginDir}/data`;
            const storageDir = `${dataDir}/storage`;

            try {
                await vaultOperations.ensureDirectory(dataDir);
                await vaultOperations.ensureDirectory(storageDir);
            } catch (error) {
                // Directories may already exist
            }

            // Update settings with correct path
            if (!settings.settings.memory) {
                settings.settings.memory = ServiceRegistrar.getDefaultMemorySettings(storageDir);
            }

            // Save settings in background
            settings.saveSettings().catch(error => {
            });

            // DEFER heavy migration work to background (2 second delay)
            // This allows the UI to appear immediately while migrations run later
            this.migrationTimer = setTimeout(async () => {
                try {
                    // Re-get vaultOperations in case it changed
                    const vaultOps = await serviceManager.getService<VaultOperations>('vaultOperations');
                    const fs = new FileSystemService(plugin, vaultOps);
                    const idx = new IndexManager(fs);

                    // Check migration status BEFORE creating directories
                    const migrationService = new DataMigrationService(plugin, fs, idx);
                    const status = await migrationService.checkMigrationStatus();

                    if (status.isRequired) {
                        // Migrate from legacy ChromaDB data
                        const result = await migrationService.performMigration();

                        if (!result.success) {
                            console.error('[ServiceRegistrar] Migration failed:', result.errors);
                        }
                    } else if (!status.migrationComplete) {
                        // No legacy data and directories don't exist - initialize fresh structure
                        await migrationService.initializeFreshDirectories();
                    }

                    // Ensure all conversations have metadata field (idempotent)
                    try {
                        const metadataResult = await migrationService.ensureConversationMetadata();
                        if (metadataResult.errors.length > 0) {
                            console.error('[ServiceRegistrar] Metadata migration errors:', metadataResult.errors);
                        }
                    } catch (error) {
                        console.error('[ServiceRegistrar] Metadata migration failed:', error);
                    }

                    // Normalize memory trace schema across all workspaces (idempotent)
                    try {
                        const traceMigrationService = new TraceSchemaMigrationService(plugin, fs, vaultOps);
                        await traceMigrationService.migrateIfNeeded();
                    } catch (error) {
                        console.error('[ServiceRegistrar] Trace schema migration failed:', error);
                    }
                } catch (error) {
                    console.error('[ServiceRegistrar] Background migration failed:', error);
                }
            }, 2000);

        } catch (error) {
            console.error('[ServiceRegistrar] Failed to initialize data directories:', error);
            // Don't throw - plugin should function without directories for now
        }
    }

    /**
     * Initialize essential services that must be ready immediately
     *
     * NOTE: This method is now a no-op for fast startup. Services are initialized
     * lazily when first requested via getService(). The UI shows immediately and
     * services spin up on-demand when chat/tools are actually used.
     */
    async initializeEssentialServices(): Promise<void> {
        // No-op for fast startup - services initialize lazily on first access
        return;
    }

    /**
     * Initialize business services with proper dependency resolution
     * Note: ChatService initialization is deferred to initializeChatService()
     */
    async initializeBusinessServices(): Promise<void> {
        try {
            // Initialize core services that agents depend on FIRST
            // These must be ready before agent initialization
            await this.context.serviceManager.getService('workspaceService');
            await this.context.serviceManager.getService('memoryService');
            await this.context.serviceManager.getService('sessionService');
            await this.context.serviceManager.getService('sessionContextManager');

            // Now initialize business services
            await this.context.serviceManager.getService('defaultWorkspaceManager');
            await this.context.serviceManager.getService('agentManager');
            await this.context.serviceManager.getService('llmService');
            await this.context.serviceManager.getService('toolCallTraceService');
            await this.context.serviceManager.getService('conversationService');

            // ChatService initialization deferred - will be called after agents are registered
        } catch (error) {
            console.error('[ServiceRegistrar] Business service initialization failed:', error);
            throw error;
        }
    }

    /**
     * Initialize ChatService AFTER agents are registered in connector
     * This ensures tools are available when ChatService initializes
     */
    async initializeChatService(): Promise<void> {
        try {
            const chatService = await this.context.serviceManager.getService<ChatService>('chatService');

            // Type guard to ensure chatService has initialize method
            if (chatService && 'initialize' in chatService && typeof chatService.initialize === 'function') {
                await chatService.initialize();
            }
        } catch (error) {
            console.error('[ServiceRegistrar] ChatService initialization failed:', error);
            throw error;
        }
    }

    /**
     * Pre-initialize UI-critical services to avoid Memory Management loading delays
     */
    async preInitializeUICriticalServices(): Promise<void> {
        if (!this.context.serviceManager) return;

        try {
            // Register additional services if not already registered
            this.registerAdditionalServices();

        } catch (error) {
            console.error('[ServiceRegistrar] UI-critical services pre-initialization failed:', error);
        }
    }

    /**
     * Get service helper method with timeout
     */
    async getService<T>(name: string, timeoutMs: number = 10000): Promise<T | null> {
        if (!this.context.serviceManager) {
            return null;
        }
        
        try {
            return await this.context.serviceManager.getService<T>(name);
        } catch (error) {
            return null;
        }
    }

    /**
     * Wait for a service to be ready with retry logic
     */
    async waitForService<T>(serviceName: string, timeoutMs: number = 30000): Promise<T | null> {
        const startTime = Date.now();
        const retryInterval = 1000; // Check every 1 second

        while (Date.now() - startTime < timeoutMs) {
            try {
                const service = await this.getService<T>(serviceName, 2000);
                if (service) {
                    return service;
                }
            } catch (error) {
                // Service not ready yet, continue waiting
            }

            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, retryInterval));
        }

        return null;
    }

    /**
     * Cancel any pending deferred timers.
     * Called by PluginLifecycleManager during plugin shutdown to prevent
     * migration callbacks from firing after the plugin has been unloaded.
     */
    shutdown(): void {
        if (this.migrationTimer !== null) {
            clearTimeout(this.migrationTimer);
            this.migrationTimer = null;
        }
    }
}
