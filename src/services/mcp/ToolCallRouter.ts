import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger';

/**
 * Location: src/services/mcp/ToolCallRouter.ts
 * 
 * This service handles routing tool calls to appropriate agents and modes, including:
 * - Tool call request validation
 * - Agent/mode resolution and execution
 * - Error handling and response formatting
 * - Tool call capture coordination
 * 
 * Used by: MCPConnector
 * Dependencies: Agent implementations, ToolCallCaptureService
 */

export interface AgentToolParams {
    agent: string;
    tool: string;
    params: Record<string, unknown>;
}

export interface ToolCallRequest {
    params: {
        name: string;
        arguments: Record<string, unknown>;
    };
    meta?: {
        requestId?: string;
        timestamp?: Date;
        source?: string;
    };
}

export interface ToolCallResponse {
    content: Array<{
        type: 'text' | 'resource';
        text?: string;
        resource?: unknown;
    }>;
    isError?: boolean;
    error?: {
        code: string;
        message: string;
        data?: unknown;
    };
}

interface AgentToolExecutor {
    executeAgentTool(agent: string, tool: string, params: Record<string, unknown>): Promise<unknown>;
}

interface BatchOperation {
    type?: unknown;
    params?: {
        filePath?: unknown;
    };
    path?: unknown;
}

function isBatchOperation(value: unknown): value is BatchOperation {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
        return error;
    }

    if (typeof error === 'string' && error.length > 0) {
        return new Error(error);
    }

    return new Error(fallbackMessage);
}

export interface ToolCallRouterInterface {
    /**
     * Routes tool call request to appropriate agent/mode
     * @param request MCP tool call request
     * @returns Promise resolving to tool call response
     * @throws RoutingError when routing fails
     * @throws ValidationError when request is invalid
     */
    route(request: ToolCallRequest): Promise<ToolCallResponse>;

    /**
     * Executes agent tool directly
     * @param agent Agent name
     * @param tool Tool name
     * @param params Tool parameters
     * @returns Promise resolving to execution result
     */
    executeAgentTool(agent: string, tool: string, params: Record<string, unknown>): Promise<unknown>;

    /**
     * Validates tool call request
     * @param request Request to validate
     * @returns Validation result
     */
    validateRequest(request: ToolCallRequest): ValidationResult;

    /**
     * Validates batch operations if present
     * @param params Parameters that may contain batch operations
     * @throws ValidationError when batch operations are invalid
     */
    validateBatchOperations(params: Record<string, unknown>): void;

    /**
     * Sets the server reference for agent tool execution
     * @param server Server instance that handles agent tool execution
     */
    setServer(server: unknown): void;
}

export interface ValidationResult {
    isValid: boolean;
    errors: string[];
}

export class ToolCallRouter implements ToolCallRouterInterface {
    private server: AgentToolExecutor | null = null;

    constructor() {}

    /**
     * Routes tool call request to appropriate agent/tool
     */
    async route(request: ToolCallRequest): Promise<ToolCallResponse> {
        try {
            // Validate the request
            const validation = this.validateRequest(request);
            if (!validation.isValid) {
                throw new McpError(
                    ErrorCode.InvalidRequest,
                    `Invalid tool call: ${validation.errors.join(', ')}`
                );
            }

            // Parse tool name to get agent (strip vault suffix)
            const { agentName } = this.parseToolName(request.params.name);

            // Get tool from arguments (with type guard for unknown)
            const toolName = request.params.arguments.tool;
            if (!toolName || typeof toolName !== 'string') {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'Tool parameter is required in tool arguments and must be a string'
                );
            }

            // Validate batch operations if present
            this.validateBatchOperations(request.params.arguments);

            // Execute the agent tool
            const result = await this.executeAgentTool(
                agentName,
                toolName,
                request.params.arguments
            );

            return this.buildSuccessResponse(result);

        } catch (error) {
            return this.buildErrorResponse(error);
        }
    }

    /**
     * Executes agent tool directly
     */
    async executeAgentTool(agent: string, tool: string, params: Record<string, unknown>): Promise<unknown> {
        if (!this.server) {
            throw new McpError(
                ErrorCode.InternalError,
                'Server not initialized for tool call routing'
            );
        }

        try {
            // Delegate to server's executeAgentTool method
            return await this.server.executeAgentTool(agent, tool, params);
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            
            logger.systemError(toError(error, 'Agent tool execution failed'), 'Agent Tool Execution');
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to execute ${agent}_${tool}`,
                error
            );
        }
    }

    /**
     * Validates tool call request
     */
    validateRequest(request: ToolCallRequest): ValidationResult {
        const errors: string[] = [];

        if (!request.params?.name) {
            errors.push('Tool name is required');
        }

        if (!request.params?.arguments) {
            errors.push('Tool arguments are required');
        }

        // Validate tool name format
        if (request.params?.name) {
            try {
                this.parseToolName(request.params.name);
            } catch (error) {
                errors.push(toError(error, 'Invalid tool name').message);
            }
        }

        return { isValid: errors.length === 0, errors };
    }

    /**
     * Validates batch operations if present in parameters
     */
    validateBatchOperations(params: Record<string, unknown>): void {
        // Validate batch operations if they exist
        const operations = params.operations;
        if (Array.isArray(operations)) {
            operations.forEach((operation, index: number) => {
                if (!isBatchOperation(operation)) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Invalid operation at index ${index} in batch operations: operation must be an object`
                    );
                }

                if (!operation.type) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Invalid operation at index ${index} in batch operations: missing 'type' property`
                    );
                }

                // Check for either filePath in params or path at the operation level
                if (!operation.params?.filePath && !operation.path) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Invalid operation at index ${index} in batch operations: missing 'filePath' property in params`
                    );
                }
            });
        }

        // Validate batch read paths if they exist
        const paths = params.paths;
        if (Array.isArray(paths)) {
            paths.forEach((path, index: number) => {
                if (typeof path !== 'string') {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Invalid path at index ${index} in batch paths: path must be a string`
                    );
                }
            });
        }
    }

    /**
     * Sets the server reference for agent tool execution
     */
    setServer(server: AgentToolExecutor): void {
        this.server = server;
    }

    /**
     * Parses tool name into agent and tool components
     * Tool name format: agentName (vault context is implicit from IPC connection)
     * Mode is extracted from request parameters, not tool name
     * @private
     */
    private parseToolName(toolName: string): { agentName: string; modeName: string } {
        // Tool name is just the agent name
        // Mode is passed separately in the request arguments
        return { agentName: toolName, modeName: '' };
    }

    /**
     * Builds successful response
     * @private
     */
    private buildSuccessResponse(result: unknown): ToolCallResponse {
        return {
            content: [{
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }],
            isError: false
        };
    }

    /**
     * Builds error response
     * @private
     */
    private buildErrorResponse(error: unknown): ToolCallResponse {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode = error instanceof McpError ? error.code : ErrorCode.InternalError;

        return {
            content: [{
                type: 'text',
                text: `Error: ${errorMessage}`
            }],
            isError: true,
            error: {
                code: String(errorCode),
                message: errorMessage,
                data: error instanceof McpError ? error.data : undefined
            }
        };
    }
}