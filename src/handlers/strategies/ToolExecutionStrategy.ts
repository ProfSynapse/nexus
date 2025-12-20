import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IRequestStrategy } from './IRequestStrategy';
import { IRequestHandlerDependencies, IRequestContext } from '../interfaces/IRequestHandlerServices';
import { IAgent } from '../../agents/interfaces/IAgent';
import { SessionContextManager } from '../../services/SessionContextManager';
import { logger } from '../../utils/logger';
import { getErrorMessage } from '../../utils/errorUtils';

interface ToolExecutionRequest {
    params: {
        name: string;
        arguments: any;
    };
}

interface ToolExecutionResponse {
    content: Array<{
        type: string;
        text: string;
    }>;
}

export class ToolExecutionStrategy implements IRequestStrategy<ToolExecutionRequest, ToolExecutionResponse> {
    private readonly instanceId = `TES_V2_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    private readonly buildVersion = 'BUILD_20250803_1755'; // Force new instances
    
    constructor(
        private dependencies: IRequestHandlerDependencies,
        private getAgent: (name: string) => IAgent,
        private sessionContextManager?: SessionContextManager,
        private onToolResponse?: (toolName: string, params: any, response: any, success: boolean, executionTime: number) => Promise<void>
    ) {
        // ToolExecutionStrategy initialized with callback support
    }

    canHandle(request: ToolExecutionRequest): boolean {
        // Handle all tool execution requests
        // We'll validate the tool exists in handle() method
        return !!(request.params && request.params.name && request.params.arguments);
    }

    async handle(request: ToolExecutionRequest): Promise<ToolExecutionResponse> {
        const startTime = Date.now();
        let context: any;
        let success = false;
        let result: any;
        
        try {
            context = await this.buildRequestContext(request);
            const processedParams = await this.processParameters(context);
            result = await this.executeTool(context, processedParams);
            success = true;
            
            // Trigger response capture callback if available
            if (this.onToolResponse) {
                try {
                    const executionTime = Date.now() - startTime;
                    await this.onToolResponse(
                        request.params.name,
                        context.params,
                        result,
                        success,
                        executionTime
                    );
                } catch (captureError) {
                    // Silently ignore capture errors
                }
            }
            
            return this.dependencies.responseFormatter.formatToolExecutionResponse(
                result,
                context.sessionInfo,
                { tool: context.tool }
            );
        } catch (error) {
            // Trigger error response capture callback if available
            if (this.onToolResponse && context) {
                try {
                    const executionTime = Date.now() - startTime;
                    await this.onToolResponse(
                        request.params.name,
                        context.params,
                        { error: (error as Error).message },
                        false,
                        executionTime
                    );
                } catch (captureError) {
                    // Silently ignore capture errors
                }
            }
            
            logger.systemError(error as Error, 'Tool Execution Strategy');
            
            // Build detailed error result object
            const errorMsg = (error as Error).message || 'Unknown error';
            let enhancedMessage = errorMsg;
            let parameterSchema: any = null;
            
            // Add helpful hints for common parameter errors
            if (errorMsg.toLowerCase().includes('parameter') || 
                errorMsg.toLowerCase().includes('required') ||
                errorMsg.toLowerCase().includes('missing')) {
                enhancedMessage += '\n\n💡 Parameter Help: Check the tool schema for required parameters and their correct format.';
                
                // Try to get parameter schema for additional context
                if (context && context.agentName && context.tool) {
                    try {
                        const agent = this.getAgent(context.agentName);
                        const toolInstance = agent.getTool(context.tool);
                        if (toolInstance && typeof toolInstance.getParameterSchema === 'function') {
                            parameterSchema = toolInstance.getParameterSchema();
                            if (parameterSchema && parameterSchema.required) {
                                enhancedMessage += `\n\n📋 Required Parameters: ${parameterSchema.required.join(', ')}`;
                            }
                        }
                    } catch (schemaError) {
                        // Ignore schema retrieval errors
                    }
                }
            }
            
            // Instead of throwing, return a formatted error response
            // This allows Claude Desktop to see the actual error message
            const errorResult = {
                success: false,
                error: enhancedMessage,
                providedParams: context?.params,
                expectedParams: parameterSchema?.required,
                suggestions: [
                    'Double-check all required parameters are provided',
                    'Ensure parameter names match the schema exactly',
                    'Check that parameter values are the correct type (string, array, object, etc.)'
                ]
            };
            
            return this.dependencies.responseFormatter.formatToolExecutionResponse(
                errorResult,
                context?.sessionInfo,
                { tool: context?.tool }
            );
        }
    }

    private async buildRequestContext(request: ToolExecutionRequest): Promise<IRequestContext & { sessionInfo: any }> {
        const { name: fullToolName, arguments: parsedArgs } = request.params;

        if (!parsedArgs) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `❌ Missing arguments for tool ${fullToolName}\n\n💡 Provide the required parameters including "tool" to specify the operation.`
            );
        }

        // Two-Tool Architecture: Handle underscore format (toolManager_getTools, toolManager_useTool)
        // MCP requires tool names match ^[a-zA-Z0-9_-]{1,64}$ (no dots allowed)
        let agentName: string;
        let tool: string;
        let params: Record<string, unknown> & {
            context?: { sessionId?: string; workspaceId?: string; [key: string]: unknown };
            sessionId?: string;
            workspaceContext?: { workspaceId?: string; [key: string]: unknown };
        };

        // Check if this is a toolManager tool (toolManager_getTools or toolManager_useTool)
        if (fullToolName.startsWith('toolManager_')) {
            // Two-tool architecture: "toolManager_getTools" → agent="toolManager", tool="getTools"
            agentName = 'toolManager';
            tool = fullToolName.substring('toolManager_'.length);
            params = { ...(parsedArgs as typeof params) };
        } else {
            // Legacy format: "contentManager_readContent" → agent="contentManager", tool from args
            agentName = this.extractAgentName(fullToolName);
            const { tool: toolFromArgs, ...restParams } = parsedArgs as { tool: string; [key: string]: unknown };
            tool = toolFromArgs;
            params = restParams as typeof params;

            if (!tool) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `❌ Missing required parameter: tool for agent ${agentName}\n\n💡 Specify which tool to use.\n\nExample: { "tool": "searchDirectory", "query": "search term", ... }`
                );
            }
        }

        // Use SessionContextManager for unified session handling instead of separate SessionService
        const sessionId = params.context?.sessionId || params.sessionId;
        
        let sessionInfo: any;
        if (this.sessionContextManager && sessionId) {
            try {
                const validationResult = await this.sessionContextManager.validateSessionId(sessionId);
                const isNonStandardId = validationResult.id !== sessionId;
                
                sessionInfo = {
                    sessionId: validationResult.id,
                    isNewSession: validationResult.created,
                    isNonStandardId: isNonStandardId,
                    originalSessionId: isNonStandardId ? sessionId : undefined
                };
                
                // Update params with validated session ID (both locations for compatibility)
                if (params.context) {
                    params.context.sessionId = validationResult.id;
                }
                params.sessionId = validationResult.id;
            } catch (error) {
                logger.systemWarn(`SessionContextManager validation failed: ${getErrorMessage(error)}. Falling back to SessionService`);
                // Fallback to original SessionService if SessionContextManager fails
                sessionInfo = await this.dependencies.sessionService.processSessionId(sessionId);
                if (params.context) {
                    params.context.sessionId = sessionInfo.sessionId;
                }
                params.sessionId = sessionInfo.sessionId;
            }
        } else {
            // Fallback to original SessionService if no SessionContextManager or sessionId
            // processSessionId handles undefined by generating a new session ID
            sessionInfo = await this.dependencies.sessionService.processSessionId(sessionId);
            if (params.context) {
                params.context.sessionId = sessionInfo.sessionId;
            }
            params.sessionId = sessionInfo.sessionId;
        }
        
        const shouldInjectInstructions = this.dependencies.sessionService.shouldInjectInstructions(
            sessionInfo.sessionId, 
            this.sessionContextManager
        );

        return {
            agentName,
            tool,
            params,
            sessionId: sessionInfo.sessionId,
            fullToolName,
            sessionContextManager: this.sessionContextManager,
            sessionInfo: {
                ...sessionInfo,
                shouldInjectInstructions
            }
        };
    }

    private async processParameters(context: IRequestContext): Promise<any> {
        const agent = this.getAgent(context.agentName);
        const toolInstance = agent.getTool(context.tool);

        let paramSchema;
        try {
            if (toolInstance && typeof toolInstance.getParameterSchema === 'function') {
                paramSchema = toolInstance.getParameterSchema();
            }
        } catch (error) {
            logger.systemWarn(`Failed to get parameter schema for tool ${context.tool}: ${getErrorMessage(error)}`);
        }

        const enhancedParams = await this.dependencies.validationService.validateToolParams(
            context.params, 
            paramSchema,
            context.fullToolName
        );

        // Session validation is now handled in buildRequestContext() to avoid duplication
        // Session description updates: support both new format (goal) and legacy (sessionDescription)
        // Note: In new format, 'goal' is the current objective. We update session description
        // to keep track of what the session is working on.
        const sessionGoal = enhancedParams.context?.goal || enhancedParams.context?.sessionDescription;
        if (this.sessionContextManager &&
            enhancedParams.context?.sessionId &&
            sessionGoal) {
            try {
                // Safety check: ensure sessionId is not undefined
                const sessionIdToUpdate = enhancedParams.context.sessionId;
                if (sessionIdToUpdate && sessionIdToUpdate !== 'undefined') {
                    await this.sessionContextManager.updateSessionDescription(
                        sessionIdToUpdate,
                        sessionGoal
                    );
                } else {
                    logger.systemWarn(`Skipping session description update - sessionId is undefined or invalid`);
                }
            } catch (error) {
                logger.systemWarn(`Session description update failed: ${getErrorMessage(error)}`);
            }
        }

        let processedParams = { ...enhancedParams };
        if (this.sessionContextManager && processedParams.context?.sessionId) {
            // Check if we need to apply workspace context from session manager
            // Skip if we already have workspaceId in context or workspaceContext
            const hasWorkspaceId = processedParams.context?.workspaceId || 
                                   (processedParams.workspaceContext && processedParams.workspaceContext.workspaceId);
            
            if (!hasWorkspaceId) {
                processedParams = this.sessionContextManager.applyWorkspaceContext(
                    processedParams.context.sessionId, 
                    processedParams
                );
            }
            
            // If we have workspaceId in context but no workspaceContext, create one for backward compatibility
            if (processedParams.context?.workspaceId && !processedParams.workspaceContext) {
                processedParams.workspaceContext = {
                    workspaceId: processedParams.context.workspaceId,
                    workspacePath: [],
                    contextDepth: 'standard'
                };
            }
        }

        return processedParams;
    }

    private async executeTool(context: IRequestContext, processedParams: any): Promise<any> {
        const agent = this.getAgent(context.agentName);
        const result = await this.dependencies.toolExecutionService.executeAgent(
            agent,
            context.tool,
            processedParams
        );

        // Update session context from result (for load operations that return new workspace context)
        if (this.sessionContextManager && processedParams.sessionId && result.workspaceContext) {
            this.sessionContextManager.updateFromResult(processedParams.sessionId, result);
        }

        return result;
    }

    private extractAgentName(toolName: string): string {
        const lastUnderscoreIndex = toolName.lastIndexOf('_');
        return lastUnderscoreIndex === -1 ? toolName : toolName.substring(0, lastUnderscoreIndex);
    }
}