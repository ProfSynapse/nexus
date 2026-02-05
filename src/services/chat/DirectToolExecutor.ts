/**
 * DirectToolExecutor - Executes tools directly via AgentExecutionManager
 *
 * This service enables tool execution without MCP protocol dependency,
 * allowing tools to work identically on both desktop and mobile platforms.
 *
 * Architecture:
 * - Desktop + Mobile (Nexus Chat): LLM → DirectToolExecutor → AgentExecutionManager → Agent
 * - Claude Desktop (external): Claude Desktop → MCP Protocol → connector.ts → Agent
 *
 * The MCP server/connector is ONLY needed for external clients (Claude Desktop).
 * The native chat UI uses this direct executor on ALL platforms.
 */

import { AgentExecutionManager } from '../../server/execution/AgentExecutionManager';
import { AgentRegistry } from '../../server/services/AgentRegistry';
import { SessionContextManager } from '../SessionContextManager';
import { ToolListService } from '../../handlers/services/ToolListService';
import { IAgent } from '../../agents/interfaces/IAgent';
import type { JSONSchema } from '../../types/schema/JSONSchemaTypes';
import type { AgentProvider } from '../agent/LazyAgentProvider';

/** OpenAI-format tool definition */
interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: JSONSchema;
    };
}

/** Tool event data for callbacks */
interface ToolEventData {
    id: string;
    name: string;
    parameters?: Record<string, unknown>;
    toolId?: string;
    result?: unknown;
    success?: boolean;
    error?: string;
}


export interface DirectToolCall {
    id: string;
    function: {
        name: string;
        arguments: string;
    };
}

export interface DirectToolResult {
    id: string;
    name?: string;
    success: boolean;
    result?: unknown;
    error?: string;
    executionTime?: number;
}

export interface DirectToolExecutorConfig {
    /** Agent provider - can be AgentRegistry, AgentRegistrationService, or any compatible provider */
    agentProvider: AgentProvider;
    sessionContextManager?: SessionContextManager;
}

/**
 * Direct tool execution service - bypasses MCP for native chat
 * Works identically on desktop and mobile platforms
 */
export class DirectToolExecutor {
    private executionManager: AgentExecutionManager;
    private toolListService: ToolListService;
    private agentProvider: AgentProvider;
    private internalRegistry: AgentRegistry;
    private cachedTools: OpenAITool[] | null = null;

    constructor(config: DirectToolExecutorConfig) {
        this.agentProvider = config.agentProvider;

        // Create internal AgentRegistry for AgentExecutionManager
        // (AgentExecutionManager requires the specific AgentRegistry type)
        this.internalRegistry = new AgentRegistry();

        // DO NOT populate registry here - agents will register lazily on first use
        // This enables fast startup by deferring agent initialization
        // Agents are registered via ensureAgentRegistered() when tools are executed

        this.executionManager = new AgentExecutionManager(
            this.internalRegistry,
            config.sessionContextManager
        );
        this.toolListService = new ToolListService();
    }

    /**
     * Ensure agent is registered before executing its tools.
     * Triggers lazy initialization if agent hasn't been loaded yet.
     */
    private async ensureAgentRegistered(agentName: string): Promise<IAgent | null> {
        // Check if already registered in internal registry
        if (this.internalRegistry.hasAgent(agentName)) {
            return this.internalRegistry.getAgent(agentName);
        }

        // Get agent from provider (triggers lazy initialization if needed)
        const agent = await this.agentProvider.getAgentAsync?.(agentName)
            ?? this.agentProvider.getAgent?.(agentName)
            ?? null;

        if (agent) {
            try {
                this.internalRegistry.registerAgent(agent);
            } catch {
                // Agent may already be registered by another concurrent call
            }
        }

        return agent;
    }

    /**
     * Get agents as an array (handles both Map and array return types)
     */
    private getAgentsAsArray(): IAgent[] {
        const result = this.agentProvider.getAllAgents();
        if (result instanceof Map) {
            return Array.from(result.values());
        }
        return result;
    }

    /**
     * Get available tools in OpenAI format - Two-Tool Architecture
     * Returns only toolManager_getTools and toolManager_useTools
     *
     * This is the new two-tool architecture that replaces the old 50+ tool surface.
     * LLMs discover tools via getTools (which lists all available agents/tools in its description),
     * then execute tools via useTools with unified context.
     */
    async getAvailableTools(): Promise<unknown[]> {
        // Get toolManager agent - triggers lazy initialization if needed
        const toolManagerAgent = await this.getAgentByNameAsync('toolManager');

        if (!toolManagerAgent) {
            console.error('[DirectToolExecutor] ToolManager agent not found - returning empty tools list');
            return [];
        }

        // Get tools from toolManager (getTools and useTools)
        const tools = toolManagerAgent.getTools();

        // Convert to OpenAI format
        // Tool names are just getTools and useTools (no prefix)
        return tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.slug,
                description: tool.description,
                parameters: tool.getParameterSchema()
            }
        }));
    }

    /**
     * Get an agent by name from the registry (sync - may return null if not initialized)
     */
    private getAgentByName(name: string): IAgent | null {
        // Check internal registry first
        if (this.internalRegistry.hasAgent(name)) {
            return this.internalRegistry.getAgent(name);
        }

        // Fall back to provider
        const result = this.agentProvider.getAllAgents();
        if (result instanceof Map) {
            return result.get(name) || null;
        }
        return result.find(a => a.name === name) || null;
    }

    /**
     * Get an agent by name with lazy initialization (async)
     * Ensures the agent is initialized and registered before returning.
     */
    private async getAgentByNameAsync(name: string): Promise<IAgent | null> {
        return this.ensureAgentRegistered(name);
    }

    /**
     * Get all tool schemas (internal - used when get_tools is called)
     */
    private async getAllToolSchemas(): Promise<OpenAITool[]> {
        // Use cached tools if available
        if (this.cachedTools) {
            return this.cachedTools;
        }

        try {
            // Get agents from provider
            const agents = this.getAgentsAsArray();
            const agentMap = new Map<string, IAgent>();

            for (const agent of agents) {
                agentMap.set(agent.name, agent);
            }

            // Generate tool list using existing service
            const { tools } = await this.toolListService.generateToolList(
                agentMap,
                true // isVaultEnabled - always true for native chat
            );

            // Convert to OpenAI format
            this.cachedTools = tools.map(tool => ({
                type: 'function' as const,
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema as JSONSchema | undefined
                }
            }));

            return this.cachedTools;
        } catch (error) {
            console.error('[DirectToolExecutor] Failed to get available tools:', error);
            return [];
        }
    }

    /**
     * Invalidate cached tools (call when agents change)
     */
    invalidateToolCache(): void {
        this.cachedTools = null;
    }

    /**
     * Execute a tool call directly via AgentExecutionManager
     * This is the core method that bypasses MCP
     */
    async executeTool(
        toolName: string,
        params: Record<string, unknown>,
        context?: { sessionId?: string; workspaceId?: string }
    ): Promise<unknown> {
        try {
            // Two-tool architecture: getTools and useTool
            if (toolName === 'getTools' || toolName === 'get_tools') {
                return await this.handleGetTools(params, context);
            }

            // Accept both singular and plural forms
            if (toolName === 'useTool' || toolName === 'useTools' || toolName === 'use_tools') {
                return await this.handleUseTool(params, context);
            }

            // Legacy/direct tool calls: "agentName_toolName" format
            let agentName: string;
            let modeName: string;
            const paramsTyped = params as Record<string, unknown> & { mode?: string; context?: Record<string, unknown> };

            if (paramsTyped.mode) {
                // Alternative format: agent name with tool in params.mode
                agentName = toolName;
                modeName = paramsTyped.mode;
            } else if (toolName.includes('_')) {
                // Standard format: agentName_toolName
                const parts = toolName.split('_');
                agentName = parts[0];
                modeName = parts.slice(1).join('_');
            } else {
                // Unknown tool name
                throw new Error(
                    `Unknown tool "${toolName}". Expected "getTools", "useTool", or "agentName_toolName" format.`
                );
            }

            // Determine sessionId and workspaceId with priority:
            // 1. External context (from chat settings/workspace selection)
            // 2. LLM-provided params.context
            // 3. Generate default if neither exists
            const effectiveSessionId = context?.sessionId
                || (paramsTyped.context?.sessionId as string | undefined)
                || `session_${Date.now()}`;
            const effectiveWorkspaceId = context?.workspaceId
                || (paramsTyped.context?.workspaceId as string | undefined)
                || 'default';

            const paramsWithContext = {
                ...params,
                context: {
                    ...paramsTyped.context,
                    sessionId: effectiveSessionId,
                    workspaceId: effectiveWorkspaceId
                }
            };

            // Ensure the agent is registered before execution (lazy initialization)
            const agent = await this.ensureAgentRegistered(agentName);
            if (!agent) {
                throw new Error(`Agent "${agentName}" not found`);
            }

            // Execute via AgentExecutionManager
            const result = await this.executionManager.executeAgentToolWithValidation(
                agentName,
                modeName,
                paramsWithContext
            );

            return result;
        } catch (error) {
            console.error(`[DirectToolExecutor] Tool execution failed for ${toolName}:`, error);
            throw error;
        }
    }

    /**
     * Handle the get_tools meta-tool call
     * Delegates to GetToolsTool for consistent schema/execution
     */
    private async handleGetTools(
        params: Record<string, unknown>,
        context?: { sessionId?: string; workspaceId?: string }
    ): Promise<unknown> {
        // Get toolManager agent to use its getTools implementation (with lazy init)
        const toolManagerAgent = await this.getAgentByNameAsync('toolManager');
        if (!toolManagerAgent) {
            return {
                success: false,
                error: 'ToolManager agent not found'
            };
        }

        const getToolsTool = toolManagerAgent.getTool('getTools');
        if (!getToolsTool) {
            return {
                success: false,
                error: 'getTools tool not found in ToolManager'
            };
        }

        // Merge context from params and external context
        const paramsContext = (params.context || {}) as Record<string, unknown>;
        const mergedParams = {
            ...params,
            context: {
                ...paramsContext,
                sessionId: context?.sessionId || paramsContext.sessionId || `session_${Date.now()}`,
                workspaceId: context?.workspaceId || paramsContext.workspaceId || 'default'
            }
        };

        // Execute via toolManager's getTools
        return await getToolsTool.execute(mergedParams);
    }

    /**
     * Handle useTool calls (two-tool architecture)
     * Executes the calls array and returns results
     */
    private async handleUseTool(
        params: Record<string, unknown>,
        context?: { sessionId?: string; workspaceId?: string }
    ): Promise<unknown> {
        // Get toolManager agent to use its useTool implementation (with lazy init)
        const toolManagerAgent = await this.getAgentByNameAsync('toolManager');
        if (!toolManagerAgent) {
            return {
                success: false,
                error: 'ToolManager agent not found'
            };
        }

        const useToolsTool = toolManagerAgent.getTool('useTools');
        if (!useToolsTool) {
            return {
                success: false,
                error: 'useTools tool not found in ToolManager'
            };
        }

        // Merge context from params and external context
        const paramsContext = (params.context || {}) as Record<string, unknown>;
        const mergedParams = {
            ...params,
            context: {
                ...paramsContext,
                sessionId: context?.sessionId || paramsContext.sessionId || `session_${Date.now()}`,
                workspaceId: context?.workspaceId || paramsContext.workspaceId || 'default'
            }
        };

        // Execute via toolManager's useTools
        return await useToolsTool.execute(mergedParams);
    }

    /**
     * Execute multiple tool calls
     * Matches the interface expected by MCPToolExecution
     */
    async executeToolCalls(
        toolCalls: DirectToolCall[],
        context?: { sessionId?: string; workspaceId?: string },
        onToolEvent?: (event: 'started' | 'completed', data: ToolEventData) => void
    ): Promise<DirectToolResult[]> {
        const results: DirectToolResult[] = [];

        for (const toolCall of toolCalls) {
            const startTime = Date.now();

            try {
                // Parse arguments
                let parameters: Record<string, unknown> = {};
                const argumentsStr = toolCall.function.arguments || '{}';

                try {
                    parameters = JSON.parse(argumentsStr);
                } catch (parseError) {
                    throw new Error(`Invalid tool arguments: ${parseError instanceof Error ? parseError.message : 'Unknown parsing error'}`);
                }

                // Notify tool started
                onToolEvent?.('started', {
                    id: toolCall.id,
                    name: toolCall.function.name,
                    parameters: parameters
                });

                // Execute the tool
                const rawResult = await this.executeTool(
                    toolCall.function.name,
                    parameters,
                    context
                );

                // Cast result to expected shape
                const result = rawResult as { success?: boolean; error?: string } | null;
                const isSuccess = result?.success !== false;
                const errorMessage = result?.success === false ? (result?.error || 'Tool execution failed') : undefined;

                const executionTime = Date.now() - startTime;

                results.push({
                    id: toolCall.id,
                    name: toolCall.function.name,
                    success: isSuccess,
                    result: isSuccess ? rawResult : undefined,
                    error: errorMessage,
                    executionTime
                });

                // Notify tool completed
                onToolEvent?.('completed', {
                    id: toolCall.id,
                    name: toolCall.function.name,
                    toolId: toolCall.id,
                    result: isSuccess ? rawResult : undefined,
                    success: isSuccess,
                    error: errorMessage
                });

            } catch (error) {
                const executionTime = Date.now() - startTime;

                results.push({
                    id: toolCall.id,
                    name: toolCall.function.name,
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                    executionTime
                });

                // Notify tool completed (with error)
                onToolEvent?.('completed', {
                    id: toolCall.id,
                    name: toolCall.function.name,
                    toolId: toolCall.id,
                    result: undefined,
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }

        return results;
    }

    /**
     * Check if tool execution is available
     * Always returns true since this doesn't depend on MCP
     */
    isAvailable(): boolean {
        return true;
    }

    /**
     * Get execution manager for advanced operations
     */
    getExecutionManager(): AgentExecutionManager {
        return this.executionManager;
    }
}
