import { App, Plugin, Events } from 'obsidian';
import NexusPlugin from './main';
import { SessionContextManager, WorkspaceContext } from './services/SessionContextManager';
import type { ServiceManager } from './core/ServiceManager';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './utils/logger';
import { CustomPromptStorageService } from "./agents/agentManager/services/CustomPromptStorageService";
import { generateSessionId, formatSessionInstructions, isStandardSessionId } from './utils/sessionUtils';
import { getContextSchema } from './utils/schemaUtils';
// ToolCallCaptureService removed in simplified architecture

// Extracted services
import { MCPConnectionManager, MCPConnectionManagerInterface } from './services/mcp/MCPConnectionManager';
import { ToolCallRouter, ToolCallRouterInterface } from './services/mcp/ToolCallRouter';
import { AgentRegistrationService, AgentRegistrationServiceInterface } from './services/agent/AgentRegistrationService';
import { ToolCallTraceService } from './services/trace/ToolCallTraceService';

// Type definitions
import { AgentToolParams } from './types/agent/AgentTypes';
import { VaultLibrarianAgent } from './agents';
import { MemoryManagerAgent } from './agents';
import { AGENTS } from './config/agentConfigs';
import { IAgent } from './agents/interfaces/IAgent';
import { ITool } from './agents/interfaces/ITool';

/**
 * Type guard to check if a plugin is a NexusPlugin instance
 */
function isNexusPlugin(plugin: Plugin | NexusPlugin): plugin is NexusPlugin {
    return 'getServiceContainer' in plugin && 'settings' in plugin;
}

/**
 * MCP Connector
 * Orchestrates MCP server operations through extracted services:
 * - MCPConnectionManager: Handles server lifecycle
 * - ToolCallRouter: Routes tool calls to agents/tools
 * - AgentRegistrationService: Manages agent initialization and registration
 */
export class MCPConnector {
    private connectionManager: MCPConnectionManagerInterface;
    private toolRouter: ToolCallRouterInterface;
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
                this.customPromptStorage = new CustomPromptStorageService(pluginSettings);
                logger.systemLog('CustomPromptStorageService initialized successfully');
            } catch (error) {
                logger.systemError(error as Error, 'CustomPromptStorageService Initialization');
                this.customPromptStorage = undefined;
            }
        } else {
            logger.systemWarn('Plugin settings not available during MCPConnector construction - will retry during initialization');
        }
        
        // Initialize extracted services
        // Note: SessionContextManager will be retrieved lazily from ServiceManager when needed
        this.connectionManager = new MCPConnectionManager(
            this.app,
            this.plugin,
            this.events,
            this.serviceManager,
            this.customPromptStorage,
            (toolName: string, params: any) => this.onToolCall(toolName, params),
            (toolName: string, params: any, response: any, success: boolean, executionTime: number) => this.onToolResponse(toolName, params, response, success, executionTime)
        );

        this.toolRouter = new ToolCallRouter();

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
    private async onToolResponse(toolName: string, params: any, response: any, success: boolean, executionTime: number): Promise<void> {
        // Tool call tracing is now handled by ToolCallTraceService
        // This callback is kept for backward compatibility
    }

    /**
     * Handle tool calls - now handled by ToolCallTraceService via MCPConnectionManager
     */
    private async onToolCall(toolName: string, params: any): Promise<void> {
        // Tool call tracing is now handled by ToolCallTraceService
        // This callback is kept for backward compatibility
    }
    
    /**
     * Check if this tool call is workspace-related
     */
    private isWorkspaceOperation(toolName: string, params: any): boolean {
        const workspaceTools = [
            'memoryManager.switchWorkspace',
            'memoryManager.createWorkspace',
            'memoryManager.getWorkspace',
            'vaultLibrarian.search'
        ];
        
        return workspaceTools.some(tool => toolName.includes(tool)) || 
               (params && (params.workspaceId || params.workspace));
    }
    
    /**
     * Extract workspace ID from tool parameters
     */
    private extractWorkspaceId(params: any): string | null {
        if (params?.workspaceId) return params.workspaceId;
        if (params?.workspace) return params.workspace;
        if (params?.params?.workspaceId) return params.params.workspaceId;
        return null;
    }
    
    /**
     * Initialize all agents - delegates to AgentRegistrationService
     */
    public async initializeAgents(): Promise<void> {
        try {
            // Ensure customPromptStorage is available if settings are now loaded
            if (!this.customPromptStorage) {
                const pluginSettings = this.plugin && isNexusPlugin(this.plugin) ? this.plugin.settings : null;
                if (pluginSettings) {
                    try {
                        this.customPromptStorage = new CustomPromptStorageService(pluginSettings);

                        // Update the agent registry with the new storage service
                        this.agentRegistry = new AgentRegistrationService(
                            this.app,
                            this.plugin,
                            this.events,
                            this.serviceManager,
                            this.customPromptStorage
                        );

                        logger.systemLog('CustomPromptStorageService initialized during agent initialization');
                    } catch (error) {
                        logger.systemError(error as Error, 'Late CustomPromptStorageService Initialization');
                    }
                }
            }
            
            // Initialize connection manager first
            await this.connectionManager.initialize();
            
            // Set up tool router with server reference
            const server = this.connectionManager.getServer();
            if (server) {
                this.toolRouter.setServer(server);
            }
            
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
     * Call a tool using the new agent-mode architecture with integrated tool call capture
     * Now delegates to ToolCallRouter service for validation and execution
     */
    /**
     * ═══════════════════════════════════════════════════════════════════
     * META-TOOLS: Special Exception to Standard Agent/Mode Pattern
     * ═══════════════════════════════════════════════════════════════════
     *
     * The following tools are defined directly in connector.ts and do NOT
     * follow the standard agent/mode pattern used by all other tools.
     *
     * Current Meta-Tools:
     * - get_tools: Dynamic tool discovery for bounded context architecture
     *
     * What get_tools Does:
     * Allows LLMs to discover and load tool schemas on-demand by requesting
     * specific agents (e.g., vaultManager, contentManager). Instead of
     * overwhelming the LLM with all 46 tools upfront, get_tools provides
     * just-in-time access to the tools needed for the current task.
     *
     * Why This Exception Exists:
     * - Tool discovery is a meta-operation, not a domain operation
     * - Requires direct access to agent registry and connector internals
     * - Must dynamically generate schemas based on registered agents
     * - Bounded context architecture intentionally has this meta-layer
     *
     * If adding more meta-tools in the future, consider creating a
     * dedicated meta-tools service to maintain consistency.
     * ═══════════════════════════════════════════════════════════════════
     */

    /**
     * Get available tools for ChatService - Two-Tool Architecture
     * Returns only toolManager_getTools and toolManager_useTool
     *
     * This is the new two-tool architecture that replaces the old 50+ tool surface.
     * LLMs discover tools via getTools (which lists all available agents/tools in its description),
     * then execute tools via useTool with unified context.
     */
    getAvailableTools(): unknown[] {
        // Get toolManager agent
        const toolManagerAgent = this.agentRegistry?.getAgent('toolManager');

        if (!toolManagerAgent) {
            logger.systemWarn('ToolManager agent not yet initialized - returning empty tools list');
            return [];
        }

        // Get tools from toolManager (getTools and useTool)
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
     * Get overview of all agents and their available tools (no schemas)
     * Used when get_tools is called with empty tools array
     */
    private getAgentToolOverview(): Record<string, { description: string; tools: string[] }> {
        const overview: Record<string, { description: string; tools: string[] }> = {};

        if (!this.agentRegistry) {
            return overview;
        }

        const registeredAgents = this.agentRegistry.getAllAgents();

        for (const [agentName, agent] of registeredAgents) {
            const tools = agent.getTools();
            const agentDescription = agent.description;

            overview[agentName] = {
                description: agentDescription,
                tools: tools.map((tool: ITool<unknown, unknown>) => tool.slug || tool.name || 'unknown')
            };
        }

        return overview;
    }

    /**
     * Get schemas for specific tool names (called via get_tools meta-tool)
     * Returns clean schemas WITHOUT common parameters to reduce context bloat
     *
     * @param toolNames Array of specific tool names like ["contentManager_createNote", "vaultLibrarian_searchDirectory"]
     */
    private getToolsForSpecificNames(toolNames: string[]): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
        const toolSchemas: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];

        if (!this.agentRegistry) {
            return [];
        }

        const registeredAgents = this.agentRegistry.getAllAgents();

        for (const toolName of toolNames) {
            // Parse tool name: "contentManager_createNote" -> agentName="contentManager", toolSlug="createNote"
            const parts = toolName.split('_');
            if (parts.length < 2) {
                continue; // Invalid tool name format
            }

            const agentName = parts[0];
            const toolSlug = parts.slice(1).join('_'); // Handle tool names with underscores

            // Find the agent
            const agent = registeredAgents.get(agentName);
            if (!agent) {
                continue; // Agent not found
            }

            // Find the tool
            const tools = agent.getTools();
            const toolInstance = tools.find((t: ITool<unknown, unknown>) =>
                (t.slug || t.name) === toolSlug
            );

            if (!toolInstance) {
                continue; // Tool not found
            }

            // Get and clean the schema
            if (typeof toolInstance.getParameterSchema === 'function') {
                try {
                    const paramSchema = toolInstance.getParameterSchema();

                    // Strip common parameters to reduce context bloat
                    // The instruction in get_tools result will tell LLM to add them
                    const cleanSchema = this.stripCommonParameters(paramSchema);

                    toolSchemas.push({
                        name: toolName,
                        description: toolInstance.description || `Execute ${toolSlug} on ${agentName}`,
                        inputSchema: cleanSchema
                    });
                } catch (error) {
                    // Skip tools with invalid schemas
                }
            }
        }

        return toolSchemas;
    }

    /**
     * Strip common parameters from tool schema to reduce context bloat
     * Common parameters (context, workspaceContext, sessionId) are documented in get_tools instruction
     */
    private stripCommonParameters(schema: any): any {
        if (!schema || !schema.properties) {
            return schema;
        }

        const { context, workspaceContext, sessionId, ...cleanProperties } = schema.properties;
        const cleanRequired = (schema.required || []).filter(
            (field: string) => field !== 'context' && field !== 'workspaceContext' && field !== 'sessionId'
        );

        return {
            ...schema,
            properties: cleanProperties,
            required: cleanRequired.length > 0 ? cleanRequired : undefined
        };
    }

    async callTool(params: AgentToolParams): Promise<unknown> {
        try {
            const { agent, tool, params: toolParams } = params;

            // ========================================
            // BOUNDED CONTEXT TOOL DISCOVERY - Intercept get_tools meta-tool
            // ========================================
            if (agent === 'get' && tool === 'tools') {
                // This is a call to the get_tools meta-tool
                const toolParamsTyped = toolParams as Record<string, unknown>;
                const contextTyped = toolParamsTyped.context as Record<string, unknown> | undefined;
                const toolNames = (toolParamsTyped.tools || contextTyped?.tools || []) as string[];

                if (!Array.isArray(toolNames)) {
                    return {
                        success: false,
                        error: 'tools parameter must be an array'
                    };
                }

                const sessionId = contextTyped?.sessionId as string | undefined;
                const workspaceId = (contextTyped?.workspaceId || 'default') as string;

                // TIER 1: Discovery mode (empty array) - return agent/tool overview
                if (toolNames.length === 0) {
                    const overview = this.getAgentToolOverview();

                    return {
                        success: true,
                        overview: overview,
                        sessionId: sessionId,
                        workspaceId: workspaceId,
                        instruction: 'Above is the overview of all available agents and their tools. To use specific tools, call get_tools again with the exact tool names (e.g., get_tools({ tools: ["contentManager_createNote", "vaultLibrarian_searchDirectory"] }))'
                    };
                }

                // TIER 2: Specific tool retrieval - return schemas for requested tools
                const tools = this.getToolsForSpecificNames(toolNames);

                if (tools.length === 0) {
                    return {
                        success: false,
                        error: `No valid tools found for the requested names: ${toolNames.join(', ')}. Make sure to use exact tool names like "contentManager_createNote".`
                    };
                }

                // Instruction for LLM to add common parameters to every tool call
                // Uses new memory/goal/constraints format (not legacy sessionDescription/sessionMemory)
                const instruction = `
IMPORTANT: All ${tools.length} tools returned require a 'context' parameter that was omitted from schemas to reduce token usage.

You MUST add the following 'context' object to EVERY tool call:

{
  "context": {
    "workspaceId": "${workspaceId}",
    "sessionId": "${sessionId || 'REQUIRED'}",
    "memory": "Essence of conversation so far (1-3 sentences)",
    "goal": "Current objective (1-3 sentences)",
    "constraints": "Optional rules/limits to follow (1-3 sentences)"
  }
}

The 4 required fields are: workspaceId, sessionId, memory, goal. constraints is optional.
Update memory and goal as the conversation evolves.
Keep workspaceId and sessionId values EXACTLY as shown above throughout the conversation.
`.trim();

                return {
                    success: true,
                    tools: tools,
                    requestedTools: toolNames,
                    toolCount: tools.length,
                    instruction: instruction
                };
            }

            // ========================================
            // SESSION VALIDATION & WORKSPACE CONTEXT INJECTION
            // ========================================

            // Type the toolParams for proper access
            const typedParams = toolParams as Record<string, unknown> & {
                context?: Record<string, unknown>;
                sessionId?: string;
                workspaceContext?: { workspaceId?: string };
            };

            // 1. SESSION ID VALIDATION: Extract and validate/generate sessionId first
            const providedSessionId = (typedParams.context?.sessionId || typedParams.sessionId) as string | undefined;
            let validatedSessionId: string;
            let isNewSession = false;
            let isNonStandardId = false;

            if (!providedSessionId || !isStandardSessionId(providedSessionId)) {
                // No sessionId or non-standard format - generate a new one
                validatedSessionId = generateSessionId();
                isNewSession = true;
                isNonStandardId = !!providedSessionId; // True if they provided a friendly name
            } else {
                // Valid standard sessionId - use it
                validatedSessionId = providedSessionId;
            }

            // 2. INJECT VALIDATED SESSION ID into all relevant locations
            if (!typedParams.context) {
                typedParams.context = {};
            }
            typedParams.context.sessionId = validatedSessionId;
            typedParams.sessionId = validatedSessionId;

            // 3. WORKSPACE CONTEXT LOOKUP FROM SESSION
            const sessionContextManager = this.getSessionContextManagerFromService();
            const workspaceContext = sessionContextManager.getWorkspaceContext(validatedSessionId);

            if (workspaceContext) {
                // Inject workspace context from session
                typedParams.workspaceContext = workspaceContext;
                typedParams.context.workspaceId = workspaceContext.workspaceId;
            } else {
                // Fallback to default if no session workspace
                if (!typedParams.workspaceContext) {
                    typedParams.workspaceContext = { workspaceId: 'default' };
                } else if (!typedParams.workspaceContext.workspaceId) {
                    typedParams.workspaceContext.workspaceId = 'default';
                }

                if (typedParams.context && !typedParams.context.workspaceId) {
                    typedParams.context.workspaceId = typedParams.workspaceContext.workspaceId;
                }
            }

            // Delegate validation and execution to ToolCallRouter
            this.toolRouter.validateBatchOperations(typedParams);
            const startTime = Date.now();
            const result = await this.toolRouter.executeAgentTool(agent, tool, typedParams);
            const executionTime = Date.now() - startTime;

            // ========================================
            // CAPTURE TOOL CALL TRACE TO WORKSPACE
            // ========================================
            const traceService = this.serviceManager?.getServiceIfReady<ToolCallTraceService>('toolCallTraceService');
            if (traceService && typeof traceService.captureToolCall === 'function') {
                const toolTraceName = `${agent}_${tool}`;
                const resultObj = result as Record<string, unknown> | null;
                const success = !resultObj?.error;

                traceService.captureToolCall(
                    toolTraceName,
                    typedParams,
                    result,
                    success,
                    executionTime
                ).catch((err: Error) => {
                    // Silent error handling for tool trace capture
                });
            }

            // Don't inject sessionId/workspaceId into result - LLM already knows these
            // since it passed them in. Adding them wastes tokens.
            // Session instructions only needed for new sessions via MCP Server path.

            return result;
            
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            throw new McpError(
                ErrorCode.InvalidParams,
                (error as Error).message || 'Failed to call tool',
                error
            );
        }
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
     * Get the MCP server instance - delegates to MCPConnectionManager
     */
    getServer(): any {
        return this.connectionManager.getServer();
    }
    
    /**
     * Get the connection manager instance
     */
    getConnectionManager(): MCPConnectionManagerInterface {
        return this.connectionManager;
    }
    
    /**
     * Get the tool router instance
     */
    getToolRouter(): ToolCallRouterInterface {
        return this.toolRouter;
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
     * Get the vault librarian instance - delegates to AgentRegistrationService
     */
    getVaultLibrarian(): VaultLibrarianAgent | null {
        return this.agentRegistry.getAgent('vaultLibrarian') as VaultLibrarianAgent | null;
    }
    
    /**
     * Get the memory manager instance - delegates to AgentRegistrationService
     */
    getMemoryManager(): MemoryManagerAgent | null {
        return this.agentRegistry.getAgent('memoryManager') as MemoryManagerAgent | null;
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
