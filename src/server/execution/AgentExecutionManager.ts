/**
 * AgentExecutionManager - Handles agent execution and session management
 * Follows Single Responsibility Principle by focusing only on agent execution
 */

import { AgentRegistry } from '../services/AgentRegistry';
import { SessionContextManager, WorkspaceContext } from '../../services/SessionContextManager';
import { NexusError, NexusErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { generateToolHelp, formatToolHelp } from '../../utils/parameterHintUtils';
import { CommonResult } from '../../types';

/**
 * Safely extracts sessionId from params as a string
 * Returns undefined if not present or not a string
 */
function getSessionIdFromParams(params: Record<string, unknown>): string | undefined {
    const sessionId = params.sessionId;
    return typeof sessionId === 'string' ? sessionId : undefined;
}

/**
 * Type guard to verify a value conforms to CommonResult interface
 */
function isCommonResult(value: unknown): value is CommonResult {
    return (
        typeof value === 'object' &&
        value !== null &&
        'success' in value &&
        typeof (value as CommonResult).success === 'boolean'
    );
}

/**
 * Service responsible for agent execution and session management
 * Follows SRP by focusing only on agent execution operations
 */
export class AgentExecutionManager {
    constructor(
        private agentRegistry: AgentRegistry,
        private sessionContextManager?: SessionContextManager
    ) {}

    /**
     * Execute a tool on an agent
     */
    async executeAgentTool(agentName: string, tool: string, params: Record<string, unknown>): Promise<unknown> {
        try {
            // Get the agent
            const agent = this.agentRegistry.validateAndGetAgent(agentName);

            // Process session context
            const processedParams = await this.processSessionContext(params);

            // Execute the tool
            const result = await agent.executeTool(tool, processedParams);

            // Update session context with result
            await this.updateSessionContext(processedParams, result);

            // Add session instructions if needed
            return this.addSessionInstructions(processedParams, result);
        } catch (error) {
            if (error instanceof NexusError) {
                throw error;
            }
            throw new NexusError(
                NexusErrorCode.InternalError,
                `Failed to execute agent ${agentName} tool ${tool}`,
                error
            );
        }
    }

    /**
     * Get detailed help for a specific tool
     */
    getToolHelp(agentName: string, toolName: string): string {
        try {
            // Get the agent
            const agent = this.agentRegistry.validateAndGetAgent(agentName);

            // Get the tool
            const tool = agent.getTool(toolName);

            if (!tool) {
                throw new NexusError(
                    NexusErrorCode.InvalidParams,
                    `Tool ${toolName} not found in agent ${agentName}`
                );
            }

            // Get the tool's parameter schema
            const schema = tool.getParameterSchema();

            // Generate tool help
            const help = generateToolHelp(
                toolName,
                tool.description,
                schema
            );

            // Format and return the help
            return formatToolHelp(help);
        } catch (error) {
            if (error instanceof NexusError) {
                throw error;
            }
            throw new NexusError(
                NexusErrorCode.InternalError,
                `Failed to get help for agent ${agentName} tool ${toolName}`,
                error
            );
        }
    }

    /**
     * Process session context for parameters
     */
    private async processSessionContext(params: Record<string, unknown>): Promise<Record<string, unknown>> {
        const sessionId = getSessionIdFromParams(params);
        if (!this.sessionContextManager || !sessionId) {
            return params;
        }

        try {
            // Validate session ID - destructure the result to get the actual ID
            const { id: validatedSessionId } = await this.sessionContextManager.validateSessionId(sessionId);
            params.sessionId = validatedSessionId;

            // Apply workspace context
            params = this.sessionContextManager.applyWorkspaceContext(validatedSessionId, params);

            return params;
        } catch (error) {
            logger.systemWarn(`Session validation failed: ${getErrorMessage(error)}. Using original ID`);
            return params;
        }
    }

    /**
     * Update session context with execution result
     */
    private async updateSessionContext(params: Record<string, unknown>, result: unknown): Promise<void> {
        const sessionId = getSessionIdFromParams(params);
        if (!this.sessionContextManager || !sessionId || !isCommonResult(result) || !result.workspaceContext) {
            return;
        }

        try {
            this.sessionContextManager.updateFromResult(sessionId, result);
        } catch (error) {
            logger.systemWarn(`Session context update failed: ${getErrorMessage(error)}`);
        }
    }

    /**
     * Add session instructions to result if needed
     */
    private addSessionInstructions(params: Record<string, unknown>, result: unknown): unknown {
        if (!this.sessionContextManager || !result || typeof result !== 'object') {
            return result;
        }

        const sessionId = getSessionIdFromParams(params);
        if (!sessionId) {
            return result;
        }

        const needsInstructions = (params._isNewSession || params._isNonStandardId) &&
                               !this.sessionContextManager.hasReceivedInstructions(sessionId);

        if (!needsInstructions) {
            return result;
        }

        // Cast to Record for mutation - this is safe since we verified it's an object
        const resultObj = result as Record<string, unknown>;

        // Add session instructions
        const originalSessionId = typeof params._originalSessionId === 'string' ? params._originalSessionId : undefined;
        if (params._isNonStandardId && originalSessionId) {
            resultObj.sessionIdCorrection = {
                originalId: originalSessionId,
                correctedId: sessionId,
                message: "Your session ID has been standardized. Please use this corrected session ID for all future requests in this conversation."
            };
        } else if (params._isNewSession && !originalSessionId) {
            resultObj.newSessionInfo = {
                sessionId: sessionId,
                message: "A new session has been created. This ID must be used for all future requests in this conversation."
            };
        }

        // Mark instructions as received
        this.sessionContextManager.markInstructionsReceived(sessionId);

        return resultObj;
    }

    /**
     * Add auto-generated session info if needed
     */
    private addAutoGeneratedSessionInfo(params: Record<string, unknown>, result: Record<string, unknown>): Record<string, unknown> {
        if (!params._autoGeneratedSessionId || !result || params._originalSessionId) {
            return result;
        }

        result.newSessionId = params.sessionId;
        result.validSessionInfo = {
            originalId: null,
            newId: params.sessionId,
            message: "No session ID was provided. A new session has been created. Please use this session ID for future requests."
        };

        return result;
    }

    /**
     * Get execution statistics
     */
    getExecutionStatistics(): {
        totalAgents: number;
        totalTools: number;
        availableTools: Array<{
            agentName: string;
            toolName: string;
            description: string;
        }>;
        hasSessionManager: boolean;
    } {
        const agentStats = this.agentRegistry.getAgentStatistics();
        const availableTools = this.agentRegistry.getAllAvailableTools();

        return {
            totalAgents: agentStats.totalAgents,
            totalTools: availableTools.length,
            availableTools,
            hasSessionManager: !!this.sessionContextManager
        };
    }

    /**
     * Validate execution parameters
     */
    validateExecutionParameters(agentName: string, tool: string, params: Record<string, unknown> | null | undefined): {
        isValid: boolean;
        errors: string[];
        warnings: string[];
    } {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Validate agent name
        if (!agentName || typeof agentName !== 'string') {
            errors.push('Agent name must be a non-empty string');
        } else if (!this.agentRegistry.hasAgent(agentName)) {
            errors.push(`Agent ${agentName} not found`);
        }

        // Validate tool
        if (!tool || typeof tool !== 'string') {
            errors.push('Tool must be a non-empty string');
        } else if (agentName && !this.agentRegistry.agentSupportsTool(agentName, tool)) {
            errors.push(`Agent ${agentName} does not support tool ${tool}`);
        }

        // Validate params
        if (params === null || params === undefined) {
            errors.push('Parameters cannot be null or undefined');
        } else if (typeof params !== 'object') {
            errors.push('Parameters must be an object');
        }

        // Session warnings
        if (params && params.sessionId && !this.sessionContextManager) {
            warnings.push('Session ID provided but no session context manager available');
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * Execute agent tool with validation
     */
    async executeAgentToolWithValidation(agentName: string, tool: string, params: Record<string, unknown>): Promise<unknown> {
        // Validate parameters
        const validation = this.validateExecutionParameters(agentName, tool, params);

        if (!validation.isValid) {
            throw new NexusError(
                NexusErrorCode.InvalidParams,
                `Invalid execution parameters: ${validation.errors.join(', ')}`
            );
        }

        // Log warnings
        validation.warnings.forEach(warning => {
            logger.systemWarn(warning);
        });

        // Execute with validation passed
        return await this.executeAgentTool(agentName, tool, params);
    }

    /**
     * Get agent tool schema
     */
    getAgentToolSchema(agentName: string, toolName: string): Record<string, unknown> {
        const agent = this.agentRegistry.validateAndGetAgent(agentName);
        const tool = agent.getTool(toolName);

        if (!tool) {
            throw new NexusError(
                NexusErrorCode.InvalidParams,
                `Tool ${toolName} not found in agent ${agentName}`
            );
        }

        return tool.getParameterSchema();
    }

    /**
     * Get execution context info
     */
    getExecutionContextInfo(sessionId?: string): {
        hasSessionManager: boolean;
        workspaceContext?: WorkspaceContext;
    } {
        const info: {
            hasSessionManager: boolean;
            workspaceContext?: WorkspaceContext;
        } = {
            hasSessionManager: !!this.sessionContextManager
        };

        if (this.sessionContextManager && sessionId) {
            try {
                // Get workspace context if available
                const workspaceContext = this.sessionContextManager.getWorkspaceContext(sessionId);
                if (workspaceContext) {
                    info.workspaceContext = workspaceContext;
                }
            } catch (error) {
                logger.systemWarn(`Failed to get execution context: ${getErrorMessage(error)}`);
            }
        }

        return info;
    }
}