import { App, Plugin, Events } from 'obsidian';
import NexusPlugin from './main';
import { SessionContextManager, WorkspaceContext } from './services/SessionContextManager';
import type { ServiceManager } from './core/ServiceManager';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './utils/logger';
import { CustomPromptStorageService } from "./agents/promptManager/services/CustomPromptStorageService";
// ToolCallCaptureService removed in simplified architecture

// Extracted services
import { MCPConnectionManager, MCPConnectionManagerInterface } from './services/mcp/MCPConnectionManager';
import { AgentRegistrationService, AgentRegistrationServiceInterface } from './services/agent/AgentRegistrationService';
import type { AppManager } from './services/apps/AppManager';
import type { MCPServer } from './server/MCPServer';

// Type definitions
import { SearchManagerAgent } from './agents';
import { MemoryManagerAgent } from './agents';
import { IAgent } from './agents/interfaces/IAgent';
import { ITool } from './agents/interfaces/ITool';

/**
 * Type guard to check if a plugin is a NexusPlugin instance
 */
function isNexusPlugin(plugin: Plugin | NexusPlugin): plugin is NexusPlugin {
    return 'getServiceContainer' in plugin && 'settings' in plugin;
}

interface ToolExecutionParams extends Record<string, unknown> {
    context?: Record<string, unknown>;
    workspaceContext?: { workspaceId?: string };
    sessionId?: string;
    workspaceId?: string;
    workspace?: string;
    params?: {
        workspaceId?: string;
        workspace?: string;
        [key: string]: unknown;
    };
}

/**
 * MCP Connector
 * Orchestrates MCP server operations through extracted services:
 * - MCPConnectionManager: Handles server lifecycle
 * - AgentRegistrationService: Manages agent initialization and registration
 *
 * Tool execution itself is not routed here: every MCP tool call goes
 * IPCTransportManager → RequestHandlerFactory → RequestRouter →
 * ToolExecutionStrategy, which owns session and workspace resolution.
 */
export class MCPConnector {
    private connectionManager: MCPConnectionManagerInterface;
    private agentRegistry: AgentRegistrationServiceInterface;
    private events: Events;
    private sessionContextManager: SessionContextManager | null = null;
    private customPromptStorage?: CustomPromptStorageService;
    private serviceManager?: ServiceManager;

    constructor(
        private app: App,
        private plugin: Plugin | NexusPlugin
    ) {
        // Initialize core components - use Obsidian's Events API
        this.events = new Events();
        // SessionContextManager will be retrieved from ServiceManager via lazy getter

        // Get service manager reference
        if (this.plugin && isNexusPlugin(this.plugin)) {
            this.serviceManager = this.plugin.getServiceContainer();
        }

        // Initialize custom prompt storage if possible
        // Note: Settings might not be fully loaded yet, so we'll check again during initialization
        const pluginSettings = this.plugin && isNexusPlugin(this.plugin) ? this.plugin.settings : null;
        if (pluginSettings) {
            try {
                // Pass null for db - connector doesn't have access to database
                this.customPromptStorage = new CustomPromptStorageService(null, pluginSettings);
                logger.systemLog('CustomPromptStorageService initialized successfully');
            } catch (error) {
                logger.systemError(error as Error, 'CustomPromptStorageService Initialization');
                this.customPromptStorage = undefined;
            }
        } else {
            logger.systemWarn('Plugin settings not available during MCPConnector construction - will retry during initialization');
        }

        const sessionContextServiceManager = this.serviceManager
            ? {
                getServiceIfReady: (name: string): SessionContextManager | null => {
                    return this.serviceManager?.getServiceIfReady<SessionContextManager>(name) ?? null;
                }
            }
            : null;
        
        // Initialize extracted services
        // Note: SessionContextManager will be retrieved lazily from ServiceManager when needed
        this.connectionManager = new MCPConnectionManager(
            this.app,
            this.plugin,
            this.events,
            sessionContextServiceManager,
            this.customPromptStorage,
            (toolName: string, params: unknown) => this.onToolCall(toolName, params),
            (toolName: string, params: unknown, response: unknown, success: boolean, executionTime: number) => this.onToolResponse(toolName, params, response, success, executionTime)
        );

        this.agentRegistry = new AgentRegistrationService(
            this.app,
            this.plugin,
            this.events,
            this.serviceManager,
            this.customPromptStorage
        );
    }

    /**
     * Lazy getter for SessionContextManager from ServiceManager
     * Ensures we use the properly initialized instance with SessionService injected
     */
    private getSessionContextManagerFromService(): SessionContextManager {
        if (!this.sessionContextManager) {
            if (!this.serviceManager) {
                throw new Error('[MCPConnector] ServiceManager not available - cannot get SessionContextManager');
            }

            this.sessionContextManager = this.serviceManager.getServiceIfReady('sessionContextManager');

            if (!this.sessionContextManager) {
                throw new Error('[MCPConnector] SessionContextManager not available from ServiceManager');
            }
        }
        return this.sessionContextManager;
    }

    /**
     * Handle tool call responses - now handled by ToolCallTraceService via MCPConnectionManager
     */
    private async onToolResponse(_toolName: string, _params: unknown, _response: unknown, _success: boolean, _executionTime: number): Promise<void> {
        // Tool call tracing is now handled by ToolCallTraceService
        // This callback is kept for backward compatibility
    }

    /**
     * Handle tool calls - now handled by ToolCallTraceService via MCPConnectionManager
     */
    private async onToolCall(_toolName: string, _params: unknown): Promise<void> {
        // Tool call tracing is now handled by ToolCallTraceService
        // This callback is kept for backward compatibility
    }
    
    /**
     * Check if this tool call is workspace-related
     */
    private isWorkspaceOperation(toolName: string, params: ToolExecutionParams | null | undefined): boolean {
        const workspaceTools = [
            'memoryManager.switchWorkspace',
            'memoryManager.createWorkspace',
            'memoryManager.getWorkspace',
            'searchManager.search'
        ];
        
        return workspaceTools.some(tool => toolName.includes(tool)) ||
            Boolean(params && (params.workspaceId || params.workspace));
    }
    
    /**
     * Extract workspace ID from tool parameters
     */
    private extractWorkspaceId(params: ToolExecutionParams | null | undefined): string | null {
        if (typeof params?.workspaceId === 'string' && params.workspaceId.length > 0) return params.workspaceId;
        if (typeof params?.workspace === 'string' && params.workspace.length > 0) return params.workspace;
        if (typeof params?.params?.workspaceId === 'string' && params.params.workspaceId.length > 0) return params.params.workspaceId;
        if (typeof params?.params?.workspace === 'string' && params.params.workspace.length > 0) return params.params.workspace;
        return null;
    }
    
    /**
     * Initialize all agents - delegates to AgentRegistrationService
     */
    public async initializeAgents(): Promise<void> {
        try {
            // Share ONE agent stack with the native chat UI instead of building a
            // second one here. The DI container already exposes a canonical
            // `agentRegistrationService` (backed by a shared AgentManager), and
            // AgentInitializationService self-provisions CustomPromptStorageService
            // when it's absent — so the shared registry serves the MCP tools too.
            // initializeAllAgents() is cached, so whoever initializes first wins and
            // the other call is a no-op: one AppManager, one set of vault watchers,
            // no duplicate spreadsheet auto-mirror/write-back. Falls back to the
            // locally-constructed registry if the container isn't available yet.
            if (this.serviceManager) {
                try {
                    const shared = await this.serviceManager.getService<AgentRegistrationService>('agentRegistrationService');
                    if (shared) {
                        this.agentRegistry = shared;
                    }
                } catch (error) {
                    logger.systemError(error as Error, 'Reuse shared AgentRegistrationService (falling back to local)');
                }
            }

            // Initialize connection manager first
            await this.connectionManager.initialize();

            const server = this.connectionManager.getServer();

            // Initialize all agents through the registration service
            await this.agentRegistry.initializeAllAgents();

            // Register agents with server through the registration service
            this.agentRegistry.registerAgentsWithServer((agent: IAgent) => {
                if (server) {
                    server.registerAgent(agent);
                }
            });
            
            // Reinitialize request router with registered agents
            this.connectionManager.reinitializeRequestRouter();

            logger.systemLog('Agent initialization completed successfully');
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'Agent Initialization');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to initialize agents',
                error
            );
        }
    }
    
    /**
     * Get available tools for ChatService - Two-Tool Architecture
     * Returns only toolManager_getTools and toolManager_useTools
     *
     * This is the new two-tool architecture that replaces the old 50+ tool surface.
     * LLMs discover tools via getTools (which lists all available agents/tools in its description),
     * then execute tools via useTools with unified context.
     */
    getAvailableTools(): unknown[] {
        // Get toolManager agent
        const toolManagerAgent = this.agentRegistry?.getAgent('toolManager');

        if (!toolManagerAgent) {
            logger.systemWarn('ToolManager agent not yet initialized - returning empty tools list');
            return [];
        }

        // Get tools from toolManager (getTools and useTools)
        const toolManagerTools = toolManagerAgent.getTools();

        // Convert to MCP tool format
        // Use underscore separator (not dots) for API compatibility
        return toolManagerTools.map((tool: ITool<unknown, unknown>) => ({
            name: `toolManager_${tool.slug}`,
            description: tool.description,
            inputSchema: tool.getParameterSchema()
        }));
    }

    /**
     * Start the MCP server - delegates to MCPConnectionManager
     */
    async start(): Promise<void> {
        try {
            // Initialize agents and connection manager first
            await this.initializeAgents();

            // Then start the server
            await this.connectionManager.start();
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'Server Start');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to start MCP server',
                error
            );
        }
    }
    
    /**
     * Stop the MCP server - delegates to MCPConnectionManager
     */
    async stop(): Promise<void> {
        try {
            await this.connectionManager.stop();
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'Server Stop');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to stop MCP server',
                error
            );
        }
    }
    
    /**
     * Release the IPC socket immediately, without awaiting the full stop.
     *
     * Called synchronously from onunload so the socket path is free before the
     * replacement plugin instance binds it. See #337.
     */
    releaseIpcSocket(): void {
        try {
            this.connectionManager.getServer()?.releaseIpcSocket();
        } catch (error) {
            logger.systemError(error as Error, 'IPC Socket Release');
        }
    }

    /**
     * Get the MCP server instance - delegates to MCPConnectionManager
     */
    getServer(): MCPServer | null {
        return this.connectionManager.getServer();
    }
    
    /**
     * Get the connection manager instance
     */
    getConnectionManager(): MCPConnectionManagerInterface {
        return this.connectionManager;
    }
    
    /**
     * Get the agent registry instance
     */
    getAgentRegistry(): AgentRegistrationServiceInterface {
        return this.agentRegistry;
    }
    
    /**
     * Get the events instance (Obsidian Events API)
     */
    getEvents(): Events {
        return this.events;
    }
    
    /**
     * Get the search manager instance - delegates to AgentRegistrationService
     */
    getSearchManager(): SearchManagerAgent | null {
        return this.agentRegistry.getAgent('searchManager') as SearchManagerAgent | null;
    }
    
    /**
     * Get the memory manager instance - delegates to AgentRegistrationService
     */
    getMemoryManager(): MemoryManagerAgent | null {
        return this.agentRegistry.getAgent('memoryManager') as MemoryManagerAgent | null;
    }

    /**
     * Get the AppManager instance - delegates to AgentRegistrationService
     */
    getAppManager(): AppManager | null {
        return this.agentRegistry.getAppManager();
    }

    /**
     * Get the session context manager instance
     */
    getSessionContextManager(): SessionContextManager {
        return this.getSessionContextManagerFromService();
    }
    
    /**
     * Set default workspace context for all new sessions
     * The default context will be used when a session doesn't have an explicit workspace context
     * 
     * @param workspaceId Workspace ID 
     * @param workspacePath Optional hierarchical path within the workspace
     * @returns True if successful
     */
    setDefaultWorkspaceContext(workspaceId: string, workspacePath?: string[]): boolean {
        if (!workspaceId) {
            logger.systemWarn('Cannot set default workspace context with empty workspaceId');
            return false;
        }
        
        const context: WorkspaceContext = {
            workspaceId,
            workspacePath,
            activeWorkspace: true
        };
        
        this.getSessionContextManagerFromService().setDefaultWorkspaceContext(context);
        return true;
    }

    /**
     * Clear the default workspace context
     */
    clearDefaultWorkspaceContext(): void {
        this.getSessionContextManagerFromService().setDefaultWorkspaceContext(null);
    }
    
    /**
     * Set workspace context for a specific session
     * 
     * @param sessionId Session ID
     * @param workspaceId Workspace ID
     * @param workspacePath Optional hierarchical path within the workspace
     * @returns True if successful
     */
    setSessionWorkspaceContext(sessionId: string, workspaceId: string, workspacePath?: string[]): boolean {
        if (!sessionId || !workspaceId) {
            logger.systemWarn('Cannot set session workspace context with empty sessionId or workspaceId');
            return false;
        }
        
        const context: WorkspaceContext = {
            workspaceId,
            workspacePath,
            activeWorkspace: true
        };
        
        this.getSessionContextManagerFromService().setWorkspaceContext(sessionId, context);
        return true;
    }
}
