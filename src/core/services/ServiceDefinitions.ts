/**
 * Location: /src/core/services/ServiceDefinitions.ts
 *
 * Service Definitions - Centralized service registration configuration
 *
 * This module defines all services in a data-driven way, making it easy to add
 * new services without modifying the core PluginLifecycleManager.
 *
 * Simplified architecture for JSON-based storage
 */

import type { App, Plugin, PluginManifest } from 'obsidian';
import { Events } from 'obsidian';
import type { ServiceManager } from '../ServiceManager';
import type { Settings } from '../../settings';
import type { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import type { DirectToolExecutor } from '../../services/chat/DirectToolExecutor';
import type { AgentRegistrationService } from '../../services/agent/AgentRegistrationService';
import type { SessionContextManager } from '../../services/SessionContextManager';
import type { SessionService } from '../../services/session/SessionService';
import type { ChatServiceDependencies } from '../../services/chat/ChatService';
import type NexusPlugin from '../../main';
import type { VaultOperations } from '../VaultOperations';
import type { WorkspaceService } from '../../services/WorkspaceService';
import type { MemoryService } from '../../agents/memoryManager/services/MemoryService';
import type { ChatTraceService } from '../../services/chat/ChatTraceService';
import type { ChatService } from '../../services/chat/ChatService';
import type { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import type { AgentManager } from '../../services/AgentManager';
import type { WorkflowRunService } from '../../services/workflows/WorkflowRunService';

export interface ServiceDefinition {
    name: string;
    dependencies?: string[];
    create: (context: ServiceCreationContext) => Promise<unknown>;
}

export interface ServiceCreationContext {
    plugin: Plugin;
    app: App;
    settings: Settings;
    serviceManager: ServiceManager;
    connector?: ChatServiceDependencies['mcpConnector'];
    manifest: PluginManifest;
}

const defineService = (create: (context: ServiceCreationContext) => Promise<unknown>) => create;

/**
 * Core service definitions in dependency order
 * Note: Events are handled via Obsidian's built-in Events API (plugin.on/trigger)
 */
export const CORE_SERVICE_DEFINITIONS: ServiceDefinition[] = [
    // VaultOperations - centralized vault operations using Obsidian API
    {
        name: 'vaultOperations',
        create: defineService(async (context) => {
            const { VaultOperations } = await import('../VaultOperations');
            const { ObsidianPathManager } = await import('../ObsidianPathManager');
            const { StructuredLogger } = await import('../StructuredLogger');

            const pathManager = new ObsidianPathManager(context.app.vault);
            const logger = new StructuredLogger(context.plugin);
            return new VaultOperations(context.app.vault, pathManager, logger);
        })
    },

    // Note: ProcessedFilesStateManager and SimpleMemoryService removed in simplify-search-architecture
    // State management is now handled by simplified JSON-based storage

    // Workspace service (centralized storage service)
    {
        name: 'workspaceService',
        dependencies: ['vaultOperations'],
        create: defineService(async (context) => {
            const { WorkspaceService } = await import('../../services/WorkspaceService');
            const { FileSystemService } = await import('../../services/storage/FileSystemService');
            const { IndexManager } = await import('../../services/storage/IndexManager');

            const vaultOperations = await context.serviceManager.getService<VaultOperations>('vaultOperations');
            const fileSystem = new FileSystemService(context.plugin, vaultOperations);
            const indexManager = new IndexManager(fileSystem);

            // Pass a lazy getter so the service re-resolves the adapter on each access.
            // This is critical because the adapter may be null at service creation time
            // (SQLite initializes in background) but becomes available later.
            const adapterGetter = () => context.serviceManager.getServiceIfReady<IStorageAdapter>('hybridStorageAdapter') ?? undefined;

            return new WorkspaceService(context.plugin, fileSystem, indexManager, adapterGetter);
        })
    },

    // Default workspace manager (ensures default workspace exists)
    {
        name: 'defaultWorkspaceManager',
        dependencies: ['workspaceService'],
        create: defineService(async (context) => {
            const { DefaultWorkspaceManager } = await import('../../services/workspace/DefaultWorkspaceManager');
            const workspaceService = await context.serviceManager.getService<WorkspaceService>('workspaceService');

            const manager = new DefaultWorkspaceManager(context.app, workspaceService);

            // Initialize in background - don't block service creation
            // Default workspace will be created lazily on first access if needed
            manager.initialize().catch(error => {
                console.error('[DefaultWorkspaceManager] Background init failed:', error);
            });

            return manager;
        })
    },

    // Memory service (agent-specific, delegates to WorkspaceService or SQLite via storageAdapter)
    {
        name: 'memoryService',
        dependencies: ['workspaceService'],
        create: defineService(async (context) => {
            const { MemoryService } = await import('../../agents/memoryManager/services/MemoryService');
            const workspaceService = await context.serviceManager.getService<WorkspaceService>('workspaceService');

            // Pass a lazy getter so the service re-resolves the adapter on each access.
            // This is critical because the adapter may be null at service creation time
            // (SQLite initializes in background) but becomes available later.
            const adapterGetter = () => context.serviceManager.getServiceIfReady<IStorageAdapter>('hybridStorageAdapter') ?? undefined;

            return new MemoryService(context.plugin, workspaceService, adapterGetter);
        })
    },

    // Cache manager for performance
    {
        name: 'cacheManager',
        dependencies: ['workspaceService', 'memoryService'],
        create: defineService(async (context) => {
            const { CacheManager } = await import('../../database/services/cache/CacheManager');

            const workspaceService = await context.serviceManager.getService<WorkspaceService>('workspaceService');
            const memoryService = await context.serviceManager.getService<MemoryService>('memoryService');

            const cacheManager = new CacheManager(
                context.plugin.app,
                workspaceService,
                memoryService,
                {
                    enableEntityCache: true,
                    enableFileIndex: true,
                    enablePrefetch: true
                }
            );

            await cacheManager.initialize();
            return cacheManager;
        })
    },

    // Session service for session persistence
    {
        name: 'sessionService',
        dependencies: ['memoryService'],
        create: defineService(async (context) => {
            const { SessionService } = await import('../../services/session/SessionService');
            type IMemoryService = import('../../services/session/SessionService').IMemoryService;
            const memoryService = await context.serviceManager.getService<IMemoryService>('memoryService');

            const service = new SessionService(memoryService);
            return service;
        })
    },

    // Session context manager
    {
        name: 'sessionContextManager',
        dependencies: ['workspaceService', 'memoryService', 'sessionService'],
        create: defineService(async (context) => {
            const { SessionContextManager } = await import('../../services/SessionContextManager');
            const sessionService = await context.serviceManager.getService<SessionService>('sessionService');

            const manager = new SessionContextManager();
            manager.setSessionService(sessionService);
            return manager;
        })
    },

    // Tool call trace service for capturing tool executions
    {
        name: 'toolCallTraceService',
        dependencies: ['memoryService', 'sessionContextManager', 'workspaceService'],
        create: defineService(async (context) => {
            const { ToolCallTraceService } = await import('../../services/trace/ToolCallTraceService');

            const memoryService = await context.serviceManager.getService<MemoryService>('memoryService');
            const sessionContextManager = await context.serviceManager.getService<SessionContextManager>('sessionContextManager');
            const workspaceService = await context.serviceManager.getService<WorkspaceService>('workspaceService');

            return new ToolCallTraceService(
                memoryService,
                sessionContextManager,
                workspaceService,
                context.plugin
            );
        })
    },

    // LLM services for chat functionality
    // Note: Tool execution is now handled by DirectToolExecutor, not mcpConnector
    {
        name: 'llmService',
        dependencies: ['vaultOperations', 'directToolExecutor'],
        create: defineService(async (context) => {
            const { LLMService } = await import('../../services/llm/core/LLMService');

            const llmProviders = context.settings.settings.llmProviders;
            if (!llmProviders || typeof llmProviders !== 'object' || !('providers' in llmProviders)) {
                throw new Error('Invalid LLM provider settings');
            }

            // Create LLMService without mcpConnector (tool execution handled separately)
            const llmService = new LLMService(llmProviders, context.app.vault);

            // Inject VaultOperations for file reading
            const vaultOperations = await context.serviceManager.getService<VaultOperations>('vaultOperations');
            if (vaultOperations) {
                llmService.setVaultOperations(vaultOperations);
            }

            // Inject DirectToolExecutor for tool execution (works on ALL platforms)
            const directToolExecutor = await context.serviceManager.getService<DirectToolExecutor>('directToolExecutor');
            if (directToolExecutor) {
                llmService.setToolExecutor(directToolExecutor);
            }

            // Wire settings persistence so token refresh is saved to disk immediately
            llmService.setOnSettingsDirty(() => {
                context.settings.saveSettings().catch(() => undefined);
            });

            return llmService;
        })
    },

    // Custom prompt storage service for AgentManager
    {
        name: 'customPromptStorageService',
        dependencies: [],
        create: defineService(async (context) => {
            const { CustomPromptStorageService } = await import('../../agents/promptManager/services/CustomPromptStorageService');

            // Access underlying SQLite database via adapter's cache property
            return new CustomPromptStorageService(null, context.settings);
        })
    },

    // Agent manager for custom AI agents (registry only - no dependencies needed)
    {
        name: 'agentManager',
        dependencies: [],
        create: defineService(async (context) => {
            const { AgentManager } = await import('../../services/AgentManager');
            return new AgentManager(
                context.plugin.app,
                context.plugin as NexusPlugin,
                new Events() // Placeholder Events instance for unused parameter
            );
        })
    },

    // Hybrid storage adapter (SQLite + JSONL) - deferred initialization for fast startup
    {
        name: 'hybridStorageAdapter',
        create: defineService(async (context) => {
            try {
                const { HybridStorageAdapter } = await import('../../database/adapters/HybridStorageAdapter');

                const adapter = new HybridStorageAdapter({
                    app: context.app,
                    basePath: '.nexus',
                    autoSync: true,
                    cacheTTL: 60000, // 1 minute query cache
                    cacheMaxSize: 500
                });

                // Start initialization in background (non-blocking)
                // ChatView will show loading indicator until ready
                void adapter.initialize(false);
                return adapter;
            } catch {
                // HybridStorageAdapter creation failed - graceful fallback to legacy storage
                return null;
            }
        })
    },

    // Conversation service for chat storage
    {
        name: 'conversationService',
        dependencies: ['vaultOperations'],
        create: defineService(async (context) => {
            const { ConversationService } = await import('../../services/ConversationService');
            const { FileSystemService } = await import('../../services/storage/FileSystemService');
            const { IndexManager } = await import('../../services/storage/IndexManager');

            const vaultOperations = await context.serviceManager.getService<VaultOperations>('vaultOperations');
            const fileSystem = new FileSystemService(context.plugin, vaultOperations);
            const indexManager = new IndexManager(fileSystem);

            // Pass a lazy getter so the service re-resolves the adapter on each access.
            // This is critical because the adapter may be null at service creation time
            // (SQLite initializes in background) but becomes available later.
            const adapterGetter = () => context.serviceManager.getServiceIfReady<IStorageAdapter>('hybridStorageAdapter') ?? undefined;

            return new ConversationService(context.plugin, fileSystem, indexManager, adapterGetter);
        })
    },

    // Agent registration service - independent of MCP, works on ALL platforms
    // Agents are initialized lazily on first access for fast startup
    {
        name: 'agentRegistrationService',
        dependencies: ['memoryService', 'workspaceService', 'agentManager'],
        create: defineService(async (context) => {
            const { AgentRegistrationService } = await import('../../services/agent/AgentRegistrationService');
            // Plugin type augmentation - NexusPlugin extends Plugin with events property
            const plugin = context.plugin as Plugin & { events?: Events };

            // Get the AgentManager service instance (not create a new one)
            const agentManager = await context.serviceManager.getService<AgentManager>('agentManager');

            // Create agent registration service with the shared AgentManager
            // NOTE: Agents are NOT initialized here - they initialize lazily on first access
            // via getAgent() or getAllAgents() for fast startup
            const agentService = new AgentRegistrationService(
                context.app,
                plugin,
                plugin.events || new Events(),
                context.serviceManager,
                undefined, // customPromptStorage - optional
                agentManager // pass the shared AgentManager
            );

            return agentService;
        })
    },

    // Direct tool executor - enables tool execution on ALL platforms (desktop + mobile)
    // Bypasses MCP protocol for native chat, uses agents directly
    // Uses LazyAgentProvider to avoid triggering agent initialization at construction
    {
        name: 'directToolExecutor',
        dependencies: ['agentRegistrationService', 'sessionContextManager'],
        create: defineService(async (context) => {
            const { DirectToolExecutor } = await import('../../services/chat/DirectToolExecutor');
            const { LazyAgentProvider } = await import('../../services/agent/LazyAgentProvider');

            const agentService = await context.serviceManager.getService<AgentRegistrationService>('agentRegistrationService');
            const sessionContextManager = context.serviceManager.getServiceIfReady<SessionContextManager>('sessionContextManager') ?? undefined;

            // Use LazyAgentProvider to avoid triggering agent initialization at construction
            // Agents will be initialized on first tool access, not at startup
            const agentProvider = new LazyAgentProvider(agentService);

            const executor = new DirectToolExecutor({
                agentProvider,
                sessionContextManager
            });

            return executor;
        })
    },

    // Chat trace service for creating memory traces from conversations
    {
        name: 'chatTraceService',
        dependencies: ['workspaceService'],
        create: defineService(async (context) => {
            const { ChatTraceService } = await import('../../services/chat/ChatTraceService');

            const workspaceService = await context.serviceManager.getService<WorkspaceService>('workspaceService');

            return new ChatTraceService({
                workspaceService
            });
        })
    },

    // Chat service with direct agent integration
    // Uses DirectToolExecutor for tool execution and ChatTraceService for memory traces
    {
        name: 'chatService',
        dependencies: ['conversationService', 'llmService', 'directToolExecutor', 'chatTraceService'],
        create: defineService(async (context) => {
            const { ChatService } = await import('../../services/chat/ChatService');

            const conversationService = await context.serviceManager.getService<ChatServiceDependencies['conversationService']>('conversationService');
            const llmService = await context.serviceManager.getService<ChatServiceDependencies['llmService']>('llmService');
            const directToolExecutor = await context.serviceManager.getService<DirectToolExecutor>('directToolExecutor');
            const chatTraceService = await context.serviceManager.getService<ChatTraceService>('chatTraceService');

            const mcpConnector = context.connector ?? {
                executeTool: async () => {
                    throw new Error('MCP connector is unavailable');
                }
            };

            const chatService = new ChatService(
                {
                    conversationService,
                    llmService,
                    vaultName: context.app.vault.getName(),
                    mcpConnector,
                    chatTraceService: chatTraceService || undefined
                },
                {
                    maxToolIterations: 10,
                    toolTimeout: 30000,
                    enableToolChaining: true
                }
            );

            // Set up DirectToolExecutor for tool execution (works on ALL platforms)
            chatService.setDirectToolExecutor(directToolExecutor);

            return chatService;
        })
    },

    {
        name: 'workflowRunService',
        dependencies: ['chatService', 'workspaceService', 'customPromptStorageService'],
        create: defineService(async (context) => {
            const { WorkflowRunService } = await import('../../services/workflows/WorkflowRunService');
            const chatService = await context.serviceManager.getService<ChatService>('chatService');
            const workspaceService = await context.serviceManager.getService<WorkspaceService>('workspaceService');
            const customPromptStorage = await context.serviceManager.getService<CustomPromptStorageService>('customPromptStorageService');

            return new WorkflowRunService({
                app: context.app,
                plugin: context.plugin,
                chatService,
                workspaceService,
                customPromptStorage
            });
        })
    },

    {
        name: 'workflowScheduleService',
        dependencies: ['workspaceService', 'conversationService', 'workflowRunService'],
        create: defineService(async (context) => {
            const { WorkflowScheduleService } = await import('../../services/workflows/WorkflowScheduleService');
            const workspaceService = await context.serviceManager.getService<WorkspaceService>('workspaceService');
            const conversationService = await context.serviceManager.getService<import('../../services/ConversationService').ConversationService>('conversationService');
            const workflowRunService = await context.serviceManager.getService<WorkflowRunService>('workflowRunService');

            return new WorkflowScheduleService({
                plugin: context.plugin,
                settings: context.settings,
                workspaceService,
                conversationService,
                workflowRunService
            });
        })
    }
];

/**
 * Interface for additional service factories with enhanced dependency injection
 */
export interface AdditionalServiceFactory {
    name: string;
    dependencies: string[];
    factory: (deps: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Additional services for UI and maintenance functionality
 */
export const ADDITIONAL_SERVICE_FACTORIES: AdditionalServiceFactory[] = [
    // Note: ChatDatabaseService removed in simplify-search-architecture
    // Chat data now stored in simplified JSON format
];

/**
 * Services that require special initialization
 */
export const SPECIALIZED_SERVICES = [
    'cacheManager',           // Requires dependency injection
    'sessionContextManager',  // Requires settings configuration
    'chatService'             // Requires MCP client initialization
];
