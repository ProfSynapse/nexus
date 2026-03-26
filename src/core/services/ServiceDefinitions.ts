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

import type { App, Plugin } from 'obsidian';
import { Events } from 'obsidian';
import type { ServiceManager } from '../ServiceManager';
import type { Settings } from '../../settings';
import type { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import type { DirectToolExecutor } from '../../services/chat/DirectToolExecutor';
import type { AgentRegistrationService } from '../../services/agent/AgentRegistrationService';
import type { SessionContextManager } from '../../services/SessionContextManager';

type VaultOperationsService = import('../VaultOperations').VaultOperations;
type WorkspaceServiceType = import('../../services/WorkspaceService').WorkspaceService;
type MemoryServiceType = import('../../agents/memoryManager/services/MemoryService').MemoryService;
type SessionMemoryService = import('../../services/session/SessionService').IMemoryService;
type AgentManagerType = import('../../services/AgentManager').AgentManager;
type ChatTraceServiceType = import('../../services/chat/ChatTraceService').ChatTraceService;
type ChatServiceType = import('../../services/chat/ChatService').ChatService;
type ConversationServiceType = import('../../services/ConversationService').ConversationService;
type CustomPromptStorageServiceType = import('../../agents/promptManager/services/CustomPromptStorageService').CustomPromptStorageService;
type WorkflowRunServiceType = import('../../services/workflows/WorkflowRunService').WorkflowRunService;

interface PluginWithEvents extends Plugin {
    events?: Events;
}

interface PromptStorageCacheLike {
    db?: unknown;
    exec: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => unknown;
}

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
    connector: unknown; // MCPConnector
    manifest: unknown;
}

function getService<T>(context: ServiceCreationContext, serviceName: string): Promise<T> {
    return context.serviceManager.getService<T>(serviceName);
}

function getServiceIfReady<T>(context: ServiceCreationContext, serviceName: string): T | undefined {
    return context.serviceManager.getServiceIfReady<T>(serviceName) ?? undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isPromptStorageCacheLike(value: unknown): value is PromptStorageCacheLike {
    return isRecord(value)
        && typeof value.exec === 'function'
        && typeof value.run === 'function';
}

function getPluginWithEvents(plugin: Plugin): PluginWithEvents {
    return plugin as PluginWithEvents;
}

/**
 * Core service definitions in dependency order
 * Note: Events are handled via Obsidian's built-in Events API (plugin.on/trigger)
 */
export const CORE_SERVICE_DEFINITIONS: ServiceDefinition[] = [
    // VaultOperations - centralized vault operations using Obsidian API
    {
        name: 'vaultOperations',
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { VaultOperations } = await import('../VaultOperations');
            const { ObsidianPathManager } = await import('../ObsidianPathManager');
            const { StructuredLogger } = await import('../StructuredLogger');

            const pathManager = new ObsidianPathManager(context.app.vault);
            const logger = new StructuredLogger(context.plugin);
            return new VaultOperations(context.app.vault, pathManager, logger);
        }
    },

    // Note: ProcessedFilesStateManager and SimpleMemoryService removed in simplify-search-architecture
    // State management is now handled by simplified JSON-based storage

    // Workspace service (centralized storage service)
    {
        name: 'workspaceService',
        dependencies: ['vaultOperations'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { WorkspaceService } = await import('../../services/WorkspaceService');
            const { FileSystemService } = await import('../../services/storage/FileSystemService');
            const { IndexManager } = await import('../../services/storage/IndexManager');

            const vaultOperations = await getService<VaultOperationsService>(context, 'vaultOperations');
            const fileSystem = new FileSystemService(context.plugin, vaultOperations);
            const indexManager = new IndexManager(fileSystem);

            // Pass a lazy getter so the service re-resolves the adapter on each access.
            // This is critical because the adapter may be null at service creation time
            // (SQLite initializes in background) but becomes available later.
            const adapterGetter = () => getServiceIfReady<IStorageAdapter>(context, 'hybridStorageAdapter');

            return new WorkspaceService(context.plugin, fileSystem, indexManager, adapterGetter);
        }
    },

    // Default workspace manager (ensures default workspace exists)
    {
        name: 'defaultWorkspaceManager',
        dependencies: ['workspaceService'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { DefaultWorkspaceManager } = await import('../../services/workspace/DefaultWorkspaceManager');
            const workspaceService = await getService<WorkspaceServiceType>(context, 'workspaceService');

            const manager = new DefaultWorkspaceManager(context.app, workspaceService);

            // Initialize in background - don't block service creation
            // Default workspace will be created lazily on first access if needed
            manager.initialize().catch(error => {
                console.error('[DefaultWorkspaceManager] Background init failed:', error);
            });

            return manager;
        }
    },

    // Memory service (agent-specific, delegates to WorkspaceService or SQLite via storageAdapter)
    {
        name: 'memoryService',
        dependencies: ['workspaceService'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { MemoryService } = await import('../../agents/memoryManager/services/MemoryService');
            const workspaceService = await getService<WorkspaceServiceType>(context, 'workspaceService');

            // Pass a lazy getter so the service re-resolves the adapter on each access.
            // This is critical because the adapter may be null at service creation time
            // (SQLite initializes in background) but becomes available later.
            const adapterGetter = () => getServiceIfReady<IStorageAdapter>(context, 'hybridStorageAdapter');

            return new MemoryService(context.plugin, workspaceService, adapterGetter);
        }
    },

    // Cache manager for performance
    {
        name: 'cacheManager',
        dependencies: ['workspaceService', 'memoryService'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { CacheManager } = await import('../../database/services/cache/CacheManager');

            const workspaceService = await getService<WorkspaceServiceType>(context, 'workspaceService');
            const memoryService = await getService<MemoryServiceType>(context, 'memoryService');

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
        }
    },

    // Session service for session persistence
    {
        name: 'sessionService',
        dependencies: ['memoryService'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { SessionService } = await import('../../services/session/SessionService');
            const memoryService = await getService<SessionMemoryService>(context, 'memoryService');

            const service = new SessionService(memoryService);
            return service;
        }
    },

    // Session context manager
    {
        name: 'sessionContextManager',
        dependencies: ['workspaceService', 'memoryService', 'sessionService'],
        create: async (_context: ServiceCreationContext): Promise<unknown> => {
            const { SessionContextManager } = await import('../../services/SessionContextManager');
            const sessionService = await getService<SessionMemoryService>(_context, 'sessionService');

            const manager = new SessionContextManager();
            manager.setSessionService(sessionService);
            return manager;
        }
    },

    // Tool call trace service for capturing tool executions
    {
        name: 'toolCallTraceService',
        dependencies: ['memoryService', 'sessionContextManager', 'workspaceService'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { ToolCallTraceService } = await import('../../services/trace/ToolCallTraceService');

            const memoryService = await getService<MemoryServiceType>(context, 'memoryService');
            const sessionContextManager = await getService<SessionContextManager>(context, 'sessionContextManager');
            const workspaceService = await getService<WorkspaceServiceType>(context, 'workspaceService');

            return new ToolCallTraceService(
                memoryService,
                sessionContextManager,
                workspaceService,
                context.plugin
            );
        }
    },

    // LLM services for chat functionality
    // Note: Tool execution is now handled by DirectToolExecutor, not mcpConnector
    {
        name: 'llmService',
        dependencies: ['vaultOperations', 'directToolExecutor'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { LLMService } = await import('../../services/llm/core/LLMService');

            const llmProviders = context.settings.settings.llmProviders;
            if (!llmProviders || typeof llmProviders !== 'object' || !('providers' in llmProviders)) {
                throw new Error('Invalid LLM provider settings');
            }

            // Create LLMService without mcpConnector (tool execution handled separately)
            const llmService = new LLMService(llmProviders, context.app.vault);

            // Inject VaultOperations for file reading
            const vaultOperations = await getService<VaultOperationsService>(context, 'vaultOperations');
            if (vaultOperations) {
                llmService.setVaultOperations(vaultOperations);
            }

            // Inject DirectToolExecutor for tool execution (works on ALL platforms)
            const directToolExecutor = await getService<DirectToolExecutor>(context, 'directToolExecutor');
            if (directToolExecutor) {
                llmService.setToolExecutor(directToolExecutor);
            }

            // Wire settings persistence so token refresh is saved to disk immediately
            llmService.setOnSettingsDirty(() => {
                context.settings.saveSettings().catch(() => {});
            });

            return llmService;
        }
    },

    // Custom prompt storage service for AgentManager
    {
        name: 'customPromptStorageService',
        dependencies: [],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { CustomPromptStorageService } = await import('../../agents/promptManager/services/CustomPromptStorageService');

            // Get storage adapter NON-BLOCKING (may be null if still initializing)
            // Service will use settings-based storage until SQLite is ready
            const storageAdapter = getServiceIfReady<IStorageAdapter>(context, 'hybridStorageAdapter');

            // Access underlying SQLite database via adapter's cache property
            let db: PromptStorageCacheLike | null = null;
            const cache = isRecord(storageAdapter) ? storageAdapter.cache : undefined;
            if (isPromptStorageCacheLike(cache)) {
                db = cache;
            }

            return new CustomPromptStorageService(db, context.settings);
        }
    },

    // Agent manager for custom AI agents (registry only - no dependencies needed)
    {
        name: 'agentManager',
        dependencies: [],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { AgentManager } = await import('../../services/AgentManager');

            return new AgentManager(
                context.plugin.app,
                context.plugin,
                new Events() // Placeholder Events instance for unused parameter
            );
        }
    },

    // Hybrid storage adapter (SQLite + JSONL) - deferred initialization for fast startup
    {
        name: 'hybridStorageAdapter',
        create: async (context: ServiceCreationContext): Promise<unknown> => {
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
        }
    },

    // Conversation service for chat storage
    {
        name: 'conversationService',
        dependencies: ['vaultOperations'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { ConversationService } = await import('../../services/ConversationService');
            const { FileSystemService } = await import('../../services/storage/FileSystemService');
            const { IndexManager } = await import('../../services/storage/IndexManager');

            const vaultOperations = await getService<VaultOperationsService>(context, 'vaultOperations');
            const fileSystem = new FileSystemService(context.plugin, vaultOperations);
            const indexManager = new IndexManager(fileSystem);

            // Pass a lazy getter so the service re-resolves the adapter on each access.
            // This is critical because the adapter may be null at service creation time
            // (SQLite initializes in background) but becomes available later.
            const adapterGetter = () => getServiceIfReady<IStorageAdapter>(context, 'hybridStorageAdapter');

            return new ConversationService(context.plugin, fileSystem, indexManager, adapterGetter);
        }
    },

    // Agent registration service - independent of MCP, works on ALL platforms
    // Agents are initialized lazily on first access for fast startup
    {
        name: 'agentRegistrationService',
        dependencies: ['memoryService', 'workspaceService', 'agentManager'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { AgentRegistrationService } = await import('../../services/agent/AgentRegistrationService');
            // Plugin type augmentation - NexusPlugin extends Plugin with events property
            const plugin = getPluginWithEvents(context.plugin);

            // Get the AgentManager service instance (not create a new one)
            const agentManager = await getService<AgentManagerType>(context, 'agentManager');

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
        }
    },

    // Direct tool executor - enables tool execution on ALL platforms (desktop + mobile)
    // Bypasses MCP protocol for native chat, uses agents directly
    // Uses LazyAgentProvider to avoid triggering agent initialization at construction
    {
        name: 'directToolExecutor',
        dependencies: ['agentRegistrationService', 'sessionContextManager'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { DirectToolExecutor } = await import('../../services/chat/DirectToolExecutor');
            const { LazyAgentProvider } = await import('../../services/agent/LazyAgentProvider');

            const agentService = await getService<AgentRegistrationService>(context, 'agentRegistrationService');
            const sessionContextManager = getServiceIfReady<SessionContextManager>(context, 'sessionContextManager');

            // Use LazyAgentProvider to avoid triggering agent initialization at construction
            // Agents will be initialized on first tool access, not at startup
            const agentProvider = new LazyAgentProvider(agentService);

            const executor = new DirectToolExecutor({
                agentProvider,
                sessionContextManager
            });

            return executor;
        }
    },

    // Chat trace service for creating memory traces from conversations
    {
        name: 'chatTraceService',
        dependencies: ['workspaceService'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { ChatTraceService } = await import('../../services/chat/ChatTraceService');

            const workspaceService = await getService<WorkspaceServiceType>(context, 'workspaceService');

            return new ChatTraceService({
                workspaceService
            });
        }
    },

    // Chat service with direct agent integration
    // Uses DirectToolExecutor for tool execution and ChatTraceService for memory traces
    {
        name: 'chatService',
        dependencies: ['conversationService', 'llmService', 'directToolExecutor', 'chatTraceService'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { ChatService } = await import('../../services/chat/ChatService');

            const conversationService = await getService<ConversationServiceType>(context, 'conversationService');
            const llmService = await getService(context, 'llmService');
            const directToolExecutor = await getService<DirectToolExecutor>(context, 'directToolExecutor');
            const chatTraceService = await getService<ChatTraceServiceType | null>(context, 'chatTraceService');

            const chatService = new ChatService(
                {
                    conversationService,
                    llmService,
                    vaultName: context.app.vault.getName(),
                    mcpConnector: context.connector, // Keep for backward compatibility, but not used for tool execution
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
        }
    },

    {
        name: 'workflowRunService',
        dependencies: ['chatService', 'workspaceService', 'customPromptStorageService'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { WorkflowRunService } = await import('../../services/workflows/WorkflowRunService');
            const chatService = await getService<ChatServiceType>(context, 'chatService');
            const workspaceService = await getService<WorkspaceServiceType>(context, 'workspaceService');
            const customPromptStorage = await getService<CustomPromptStorageServiceType>(context, 'customPromptStorageService');

            return new WorkflowRunService({
                app: context.app,
                plugin: context.plugin,
                chatService,
                workspaceService,
                customPromptStorage
            });
        }
    },

    {
        name: 'workflowScheduleService',
        dependencies: ['workspaceService', 'conversationService', 'workflowRunService'],
        create: async (context: ServiceCreationContext): Promise<unknown> => {
            const { WorkflowScheduleService } = await import('../../services/workflows/WorkflowScheduleService');
            const workspaceService = await getService<WorkspaceServiceType>(context, 'workspaceService');
            const conversationService = await getService<ConversationServiceType>(context, 'conversationService');
            const workflowRunService = await getService<WorkflowRunServiceType>(context, 'workflowRunService');

            return new WorkflowScheduleService({
                plugin: context.plugin,
                settings: context.settings,
                workspaceService,
                conversationService,
                workflowRunService
            });
        }
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
