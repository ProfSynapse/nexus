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
    result?: any;
    error?: string;
    executionTime?: number;
}

/**
 * Interface for agent providers - both AgentRegistry and AgentRegistrationService can fulfill this
 */
export interface AgentProvider {
    getAllAgents(): Map<string, IAgent> | IAgent[];
    getAgent?(name: string): IAgent | null;
    hasAgent?(name: string): boolean;
    agentSupportsMode?(agentName: string, modeName: string): boolean;
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
    private cachedTools: any[] | null = null;

    constructor(config: DirectToolExecutorConfig) {
        this.agentProvider = config.agentProvider;

        // Create internal AgentRegistry for AgentExecutionManager
        // (AgentExecutionManager requires the specific AgentRegistry type)
        this.internalRegistry = new AgentRegistry();

        // Populate internal registry from provider
        const agents = this.getAgentsAsArray();
        for (const agent of agents) {
            try {
                this.internalRegistry.registerAgent(agent);
            } catch {
                // Agent may already be registered (e.g., if provider is an AgentRegistry)
            }
        }

        this.executionManager = new AgentExecutionManager(
            this.internalRegistry,
            config.sessionContextManager
        );
        this.toolListService = new ToolListService();
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
     * Returns only toolManager.getTools and toolManager.useTool
     *
     * This is the new two-tool architecture that replaces the old 50+ tool surface.
     * LLMs discover tools via getTools (which lists all available agents/tools in its description),
     * then execute tools via useTool with unified context.
     */
    async getAvailableTools(): Promise<unknown[]> {
        // Get toolManager agent from the registry
        const toolManagerAgent = this.getAgentByName('toolManager');

        if (!toolManagerAgent) {
            console.error('[DirectToolExecutor] ToolManager agent not found - returning empty tools list');
            return [];
        }

        // Get tools from toolManager (getTools and useTool)
        const tools = toolManagerAgent.getTools();

        // Convert to OpenAI format
        return tools.map(tool => ({
            type: 'function',
            function: {
                name: `toolManager.${tool.slug}`,
                description: tool.description,
                parameters: tool.getParameterSchema()
            }
        }));
    }

    /**
     * Get an agent by name from the registry
     */
    private getAgentByName(name: string): IAgent | null {
        const result = this.agentProvider.getAllAgents();
        if (result instanceof Map) {
            return result.get(name) || null;
        }
        return result.find(a => a.name === name) || null;
    }

    /**
     * Get all tool schemas (internal - used when get_tools is called)
     */
    private async getAllToolSchemas(): Promise<any[]> {
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
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema
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
            // Handle legacy get_tools meta-tool (backward compatibility)
            if (toolName === 'get_tools') {
                return await this.handleGetTools(params, context);
            }

            // Two-tool architecture: "agentName.toolName" format
            if (toolName.includes('.')) {
                const [agentName, toolSlug] = toolName.split('.');

                // Get the agent
                const agent = this.getAgentByName(agentName);
                if (!agent) {
                    throw new Error(`Agent "${agentName}" not found`);
                }

                // Get the tool
                const tool = agent.getTool(toolSlug);
                if (!tool) {
                    throw new Error(`Tool "${toolSlug}" not found in agent "${agentName}"`);
                }

                // Determine sessionId and workspaceId
                const paramsWithContext = params as Record<string, unknown> & {
                    context?: { sessionId?: string; workspaceId?: string };
                };
                const effectiveSessionId = context?.sessionId
                    || paramsWithContext.context?.sessionId
                    || `session_${Date.now()}`;
                const effectiveWorkspaceId = context?.workspaceId
                    || paramsWithContext.context?.workspaceId
                    || 'default';

                // Build params with context
                const toolParams = {
                    ...params,
                    context: {
                        ...(paramsWithContext.context || {}),
                        sessionId: effectiveSessionId,
                        workspaceId: effectiveWorkspaceId
                    }
                };

                // Execute via agent's executeTool method
                return await agent.executeTool(toolSlug, toolParams);
            }

            // Legacy format: "agentName" with mode in params
            // Or: "agentName_modeName"
            let agentName: string;
            let modeName: string;
            const paramsTyped = params as Record<string, unknown> & { mode?: string; context?: Record<string, unknown> };

            if (paramsTyped.mode) {
                // New format: mode is in params
                agentName = toolName;
                modeName = paramsTyped.mode;
            } else if (toolName.includes('_')) {
                // Legacy format: agentName_modeName
                const parts = toolName.split('_');
                agentName = parts[0];
                modeName = parts.slice(1).join('_');
            } else {
                throw new Error(`Invalid tool call: no mode specified for ${toolName}`);
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

            // Execute via AgentExecutionManager
            const result = await this.executionManager.executeAgentModeWithValidation(
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
     * Returns tool schemas for requested agents
     */
    private async handleGetTools(
        params: Record<string, any>,
        context?: { sessionId?: string; workspaceId?: string }
    ): Promise<any> {
        const requestedTools = params.tools as string[] | undefined;
        const sessionId = context?.sessionId || 'session_' + Date.now();
        const workspaceId = context?.workspaceId || 'default';

        // No tools requested - remind to specify which tools
        if (!requestedTools || requestedTools.length === 0) {
            return {
                success: false,
                error: 'Please specify which agent tools you need. Example: get_tools({ tools: ["contentManager", "vaultLibrarian"] })',
                availableAgents: ['contentManager', 'vaultManager', 'vaultLibrarian', 'memoryManager', 'commandManager', 'agentManager']
            };
        }

        // Get schemas for requested tools
        const allTools = await this.getAllToolSchemas();
        const matchedTools: any[] = [];
        const notFound: string[] = [];

        for (const toolName of requestedTools) {
            const tool = allTools.find(t => t.function.name === toolName);
            if (tool) {
                matchedTools.push(tool);
            } else {
                notFound.push(toolName);
            }
        }

        return {
            success: true,
            tools: matchedTools,
            count: matchedTools.length,
            notFound: notFound.length > 0 ? notFound : undefined,
            reminder: `Use sessionId: "${sessionId}" and workspaceId: "${workspaceId}" in context for all tool calls.`
        };
    }

    /**
     * Execute multiple tool calls
     * Matches the interface expected by MCPToolExecution
     */
    async executeToolCalls(
        toolCalls: DirectToolCall[],
        context?: { sessionId?: string; workspaceId?: string },
        onToolEvent?: (event: 'started' | 'completed', data: any) => void
    ): Promise<DirectToolResult[]> {
        const results: DirectToolResult[] = [];

        for (const toolCall of toolCalls) {
            const startTime = Date.now();

            try {
                // Parse arguments
                let parameters: any = {};
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
