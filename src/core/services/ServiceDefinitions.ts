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

import type { Plugin } from 'obsidian';
import { Events } from 'obsidian';
import type { ServiceManager } from '../ServiceManager';
import type { Settings } from '../../settings';
import type { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import type { DirectToolExecutor } from '../../services/chat/DirectToolExecutor';
import type { AgentRegistrationService } from '../../services/agent/AgentRegistrationService';
import type { SessionContextManager } from '../../services/SessionContextManager';

export interface ServiceDefinition {
    name: string;
    dependencies?: string[];
    create: (context: ServiceCreationContext) => Promise<any>;
}

export interface ServiceCreationContext {
    plugin: Plugin;
    app: any;
    settings: Settings;
    serviceManager: ServiceManager;
    connector: any; // MCPConnector
    manifest: any;
}

/**
 * Core service definitions in dependency order
 * Note: Events are handled via Obsidian's built-in Events API (plugin.on/trigger)
 */
export const CORE_SERVICE_DEFINITIONS: ServiceDefinition[] = [
    // VaultOperations - centralized vault operations using Obsidian API
    {
        name: 'vaultOperations',
        create: async (context) => {
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
        dependencies: ['hybridStorageAdapter', 'vaultOperations'],
        create: async (context) => {
            const { WorkspaceService } = await import('../../services/WorkspaceService');
            const { FileSystemService } = await import('../../services/storage/FileSystemService');
            const { IndexManager } = await import('../../services/storage/IndexManager');
            const { VaultOperations } = await import('../VaultOperations');

            const vaultOperations = await context.serviceManager.getService('vaultOperations') as InstanceType<typeof VaultOperations>;
            const fileSystem = new FileSystemService(context.plugin, vaultOperations);
            const indexManager = new IndexManager(fileSystem);

            // Get storage adapter if available (may be null if initialization failed)
            const storageAdapter = await context.serviceManager.getService<IStorageAdapter | null>('hybridStorageAdapter');

            return new WorkspaceService(context.plugin, fileSystem, indexManager, storageAdapter || undefined);
        }
    },

    // Default workspace manager (ensures default workspace exists)
    {
        name: 'defaultWorkspaceManager',
        dependencies: ['workspaceService'],
        create: async (context) => {
            const { DefaultWorkspaceManager } = await import('../../services/workspace/DefaultWorkspaceManager');
            const { WorkspaceService } = await import('../../services/WorkspaceService');
            const workspaceService = await context.serviceManager.getService('workspaceService') as InstanceType<typeof WorkspaceService>;

            const manager = new DefaultWorkspaceManager(context.app, workspaceService);
            await manager.initialize();
            return manager;
        }
    },

    // Memory service (agent-specific, delegates to WorkspaceService or SQLite via storageAdapter)
    {
        name: 'memoryService',
        dependencies: ['workspaceService', 'hybridStorageAdapter'],
        create: async (context) => {
            const { MemoryService } = await import('../../agents/memoryManager/services/MemoryService');
            const WorkspaceService = (await import('../../services/WorkspaceService')).WorkspaceService;
            const workspaceService = await context.serviceManager.getService('workspaceService') as InstanceType<typeof WorkspaceService>;

            // Get storage adapter if available (may be null if initialization failed)
            const storageAdapter = await context.serviceManager.getService<IStorageAdapter | null>('hybridStorageAdapter');

            return new MemoryService(context.plugin, workspaceService, storageAdapter || undefined);
        }
    },

    // Cache manager for performance
    {
        name: 'cacheManager',
        dependencies: ['workspaceService', 'memoryService'],
        create: async (context) => {
            const { CacheManager } = await import('../../database/services/cache/CacheManager');
            const { WorkspaceService } = await import('../../services/WorkspaceService');
            const { MemoryService } = await import('../../agents/memoryManager/services/MemoryService');

            const workspaceService = await context.serviceManager.getService<InstanceType<typeof WorkspaceService>>('workspaceService');
            const memoryService = await context.serviceManager.getService<InstanceType<typeof MemoryService>>('memoryService');

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
        create: async (context) => {
            const { SessionService } = await import('../../services/session/SessionService');
            type IMemoryService = import('../../services/session/SessionService').IMemoryService;
            const memoryService = await context.serviceManager.getService('memoryService') as IMemoryService;

            const service = new SessionService(memoryService);
            return service;
        }
    },

    // Session context manager
    {
        name: 'sessionContextManager',
        dependencies: ['workspaceService', 'memoryService', 'sessionService'],
        create: async (context) => {
            const { SessionContextManager } = await import('../../services/SessionContextManager');

            const workspaceService = await context.serviceManager.getService('workspaceService');
            const memoryService = await context.serviceManager.getService('memoryService');
            const sessionService = await context.serviceManager.getService('sessionService');

            const manager = new SessionContextManager();
            manager.setSessionService(sessionService);
            return manager;
        }
    },

    // Tool call trace service for capturing tool executions
    {
        name: 'toolCallTraceService',
        dependencies: ['memoryService', 'sessionContextManager', 'workspaceService'],
        create: async (context) => {
            const { ToolCallTraceService } = await import('../../services/trace/ToolCallTraceService');
            const { MemoryService } = await import('../../agents/memoryManager/services/MemoryService');
            const { SessionContextManager } = await import('../../services/SessionContextManager');
            const { WorkspaceService } = await import('../../services/WorkspaceService');

            const memoryService = await context.serviceManager.getService('memoryService') as InstanceType<typeof MemoryService>;
            const sessionContextManager = await context.serviceManager.getService('sessionContextManager') as InstanceType<typeof SessionContextManager>;
            const workspaceService = await context.serviceManager.getService('workspaceService') as InstanceType<typeof WorkspaceService>;

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
        create: async (context) => {
            const { LLMService } = await import('../../services/llm/core/LLMService');
            const { VaultOperations } = await import('../../core/VaultOperations');

            const llmProviders = context.settings.settings.llmProviders;
            if (!llmProviders || typeof llmProviders !== 'object' || !('providers' in llmProviders)) {
                throw new Error('Invalid LLM provider settings');
            }

            // Create LLMService without mcpConnector (tool execution handled separately)
            const llmService = new LLMService(llmProviders, context.app.vault);

            // Inject VaultOperations for file reading
            const vaultOperations = await context.serviceManager.getService('vaultOperations') as InstanceType<typeof VaultOperations>;
            if (vaultOperations) {
                llmService.setVaultOperations(vaultOperations);
            }

            // Inject DirectToolExecutor for tool execution (works on ALL platforms)
            const directToolExecutor = await context.serviceManager.getService<DirectToolExecutor>('directToolExecutor');
            if (directToolExecutor) {
                llmService.setToolExecutor(directToolExecutor);
            }

            return llmService;
        }
    },

    // Custom prompt storage service for AgentManager
    {
        name: 'customPromptStorageService',
        dependencies: ['hybridStorageAdapter'],
        create: async (context) => {
            const { CustomPromptStorageService } = await import('../../agents/promptManager/services/CustomPromptStorageService');

            // Get storage adapter if available (may be null if initialization failed)
            const storageAdapter = await context.serviceManager.getService<IStorageAdapter | null>('hybridStorageAdapter');

            // Access underlying SQLite database via adapter's cache property
            let db = null;
            if (storageAdapter && 'cache' in storageAdapter) {
                const cache = (storageAdapter as any).cache;
                // Check if cache has the necessary methods
                if (cache && typeof cache.exec === 'function' && typeof cache.run === 'function') {
                    db = cache;
                }
            }

            return new CustomPromptStorageService(db, context.settings);
        }
    },

    // Agent manager for custom AI agents (registry only - no dependencies needed)
    {
        name: 'agentManager',
        dependencies: [],
        create: async (context) => {
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
        create: async (context) => {
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
                adapter.initialize(false);
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
        dependencies: ['hybridStorageAdapter', 'vaultOperations'],
        create: async (context) => {
            const { ConversationService } = await import('../../services/ConversationService');
            const { FileSystemService } = await import('../../services/storage/FileSystemService');
            const { IndexManager } = await import('../../services/storage/IndexManager');
            const { VaultOperations } = await import('../VaultOperations');

            const vaultOperations = await context.serviceManager.getService('vaultOperations') as InstanceType<typeof VaultOperations>;
            const fileSystem = new FileSystemService(context.plugin, vaultOperations);
            const indexManager = new IndexManager(fileSystem);

            // Get storage adapter if available (may be null if initialization failed)
            const storageAdapter = await context.serviceManager.getService<IStorageAdapter | null>('hybridStorageAdapter');

            return new ConversationService(context.plugin, fileSystem, indexManager, storageAdapter || undefined);
        }
    },

    // Agent registration service - independent of MCP, works on ALL platforms
    // This initializes agents without requiring the MCP connector
    {
        name: 'agentRegistrationService',
        dependencies: ['memoryService', 'workspaceService', 'agentManager'],
        create: async (context) => {
            const { AgentRegistrationService } = await import('../../services/agent/AgentRegistrationService');
            const { AgentManager } = await import('../../services/AgentManager');
            // Plugin type augmentation - NexusPlugin extends Plugin with events property
            const plugin = context.plugin as Plugin & { events?: Events };

            // Get the AgentManager service instance (not create a new one)
            const agentManager = await context.serviceManager.getService('agentManager') as InstanceType<typeof AgentManager>;

            // Create agent registration service with the shared AgentManager
            const agentService = new AgentRegistrationService(
                context.app,
                plugin,
                plugin.events || new Events(),
                context.serviceManager,
                undefined, // customPromptStorage - optional
                agentManager // pass the shared AgentManager
            );

            // Initialize all agents
            await agentService.initializeAllAgents();

            return agentService;
        }
    },

    // Direct tool executor - enables tool execution on ALL platforms (desktop + mobile)
    // Bypasses MCP protocol for native chat, uses agents directly
    {
        name: 'directToolExecutor',
        dependencies: ['agentRegistrationService', 'sessionContextManager'],
        create: async (context) => {
            const { DirectToolExecutor } = await import('../../services/chat/DirectToolExecutor');

            const agentService = await context.serviceManager.getService<AgentRegistrationService>('agentRegistrationService');
            const sessionContextManager = context.serviceManager.getServiceIfReady<SessionContextManager>('sessionContextManager') ?? undefined;

            // Wrap agentService to match AgentProvider interface
            const agentProvider = {
                getAllAgents: () => agentService.getAllAgents(),
                getAgent: (name: string) => agentService.getAgent(name),
                hasAgent: (name: string) => agentService.getAgent(name) !== null,
                agentSupportsMode: () => true // Let execution fail if tool not supported
            };

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
        create: async (context) => {
            const { ChatTraceService } = await import('../../services/chat/ChatTraceService');
            const { WorkspaceService } = await import('../../services/WorkspaceService');

            const workspaceService = await context.serviceManager.getService('workspaceService') as InstanceType<typeof WorkspaceService>;

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
        create: async (context) => {
            const { ChatService } = await import('../../services/chat/ChatService');
            const { ChatTraceService } = await import('../../services/chat/ChatTraceService');

            const conversationService = await context.serviceManager.getService('conversationService');
            const llmService = await context.serviceManager.getService('llmService');
            const directToolExecutor = await context.serviceManager.getService('directToolExecutor');
            const chatTraceService = await context.serviceManager.getService('chatTraceService') as InstanceType<typeof ChatTraceService> | null;

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
            chatService.setDirectToolExecutor(directToolExecutor as DirectToolExecutor);

            return chatService;
        }
    }
];

/**
 * Interface for additional service factories with enhanced dependency injection
 */
export interface AdditionalServiceFactory {
    name: string;
    dependencies: string[];
    factory: (deps: Record<string, unknown>) => Promise<any>;
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