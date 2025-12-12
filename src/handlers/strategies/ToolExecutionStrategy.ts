import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IRequestStrategy } from './IRequestStrategy';
import { IRequestHandlerDependencies, IRequestContext } from '../interfaces/IRequestHandlerServices';
import { IAgent } from '../../agents/interfaces/IAgent';
import { SessionContextManager } from '../../services/SessionContextManager';
import { logger } from '../../utils/logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { parseAgentToolName } from '../../utils/toolNameUtils';
import { normalizeToolContext } from '../../utils/toolContextUtils';

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
                    const paramsForCapture = { ...context.params, mode: context.mode };
                    await this.onToolResponse(
                        request.params.name,
                        paramsForCapture,
                        result,
                        success,
                        executionTime
                    );
                } catch (captureError) {
                    console.warn('[ToolExecutionStrategy] Response capture failed:', captureError);
                }
            }
            
            return this.dependencies.responseFormatter.formatToolExecutionResponse(
                result,
                context.sessionInfo,
                { mode: context.mode }
            );
        } catch (error) {
            // Trigger error response capture callback if available
            if (this.onToolResponse && context) {
                try {
                    const executionTime = Date.now() - startTime;
                    const paramsForCapture = context?.params
                        ? { ...context.params, ...(context?.mode ? { mode: context.mode } : {}) }
                        : context?.params;
                    await this.onToolResponse(
                        request.params.name,
                        paramsForCapture,
                        { error: (error as Error).message },
                        false,
                        executionTime
                    );
                } catch (captureError) {
                    console.warn('[ToolExecutionStrategy] Error response capture failed:', captureError);
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
                if (context && context.agentName && context.mode) {
                    try {
                        const agent = this.getAgent(context.agentName);
                        const modeInstance = agent.getMode(context.mode);
                        if (modeInstance && typeof modeInstance.getParameterSchema === 'function') {
                            parameterSchema = modeInstance.getParameterSchema();
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
                { mode: context?.mode }
            );
        }
    }

    private async buildRequestContext(request: ToolExecutionRequest): Promise<IRequestContext & { sessionInfo: any }> {
        const { name: fullToolName, arguments: parsedArgs } = request.params;
        
        if (!parsedArgs) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `❌ Missing arguments for tool ${fullToolName}\n\n💡 Provide the required parameters including "mode" to specify the operation.`
            );
        }

        const agentName = parseAgentToolName(fullToolName).agentName;
        const { mode, ...params } = parsedArgs as { mode: string; [key: string]: any };
        
        if (!mode) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `❌ Missing required parameter: mode for agent ${agentName}\n\n💡 Specify which operation mode to use.\n\nExample: { "mode": "searchDirectoryMode", "query": "search term", ... }`
            );
        }

        const normalized = await normalizeToolContext(params, {
            sessionContextManager: this.sessionContextManager ?? undefined,
            fallbackSessionIdProcessor: (sessionId: string) => this.dependencies.sessionService.processSessionId(sessionId),
            defaultWorkspaceId: 'default'
        });

        const shouldInjectInstructions = this.dependencies.sessionService.shouldInjectInstructions(
            normalized.session.sessionId, 
            this.sessionContextManager
        );

        return {
            agentName,
            mode,
            params: normalized.params,
            sessionId: normalized.session.sessionId,
            fullToolName,
            sessionContextManager: this.sessionContextManager,
            sessionInfo: {
                sessionId: normalized.session.sessionId,
                isNewSession: normalized.session.isNewSession,
                isNonStandardId: normalized.session.isNonStandardId,
                originalSessionId: normalized.session.originalSessionId,
                shouldInjectInstructions
            }
        };
    }

    private async processParameters(context: IRequestContext): Promise<any> {
        const agent = this.getAgent(context.agentName);
        const modeInstance = agent.getMode(context.mode);
        
        let paramSchema;
        try {
            if (modeInstance && typeof modeInstance.getParameterSchema === 'function') {
                paramSchema = modeInstance.getParameterSchema();
            }
        } catch (error) {
            logger.systemWarn(`Failed to get parameter schema for mode ${context.mode}: ${getErrorMessage(error)}`);
        }

        const enhancedParams = await this.dependencies.validationService.validateToolParams(
            context.params, 
            paramSchema,
            context.fullToolName
        );

        // Session validation is now handled in buildRequestContext() to avoid duplication
        // Only handle session description updates here if needed
        if (this.sessionContextManager && 
            enhancedParams.context?.sessionId && 
            enhancedParams.context?.sessionDescription) {
            try {
                // Safety check: ensure sessionId is not undefined
                const sessionIdToUpdate = enhancedParams.context.sessionId;
                if (sessionIdToUpdate && sessionIdToUpdate !== 'undefined') {
                    await this.sessionContextManager.updateSessionDescription(
                        sessionIdToUpdate, 
                        enhancedParams.context.sessionDescription
                    );
                } else {
                    logger.systemWarn(`Skipping session description update - sessionId is undefined or invalid`);
                }
            } catch (error) {
                logger.systemWarn(`Session description update failed: ${getErrorMessage(error)}`);
            }
        }

        return enhancedParams;
    }

    private async executeTool(context: IRequestContext, processedParams: any): Promise<any> {
        const agent = this.getAgent(context.agentName);
        const result = await this.dependencies.toolExecutionService.executeAgent(
            agent,
            context.mode,
            processedParams
        );

        // Update session context from result (for load operations that return new workspace context)
        const sessionId = processedParams.context?.sessionId;
        if (this.sessionContextManager && sessionId && result.workspaceContext) {
            this.sessionContextManager.updateFromResult(sessionId, result);
        }

        return result;
    }
}
