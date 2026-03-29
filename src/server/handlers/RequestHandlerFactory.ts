/**
 * RequestHandlerFactory - Creates and configures request handlers
 * Follows Single Responsibility Principle by focusing only on handler setup
 */

import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ServerResult
} from '@modelcontextprotocol/sdk/types.js';
import { RequestRouter } from '../../handlers/RequestRouter';
import { parseJsonArrays } from '../../utils/jsonUtils';
import { logger } from '../../utils/logger';

// MCP SDK result types for handler return values
type MCPResult = ServerResult | Record<string, unknown>;
type ToolCallHook = (toolName: string, params: unknown) => Promise<void>;
type ToolArguments = Record<string, unknown>;
type ToolCallRequest = Record<string, unknown> & {
    params: {
        name: string;
        arguments: unknown;
    };
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isToolCallRequest(request: unknown): request is ToolCallRequest {
    if (!isRecord(request) || !isRecord(request.params)) {
        return false;
    }

    return typeof request.params.name === 'string' && 'arguments' in request.params;
}

function getToolCallRequest(request: unknown): ToolCallRequest {
    if (!isToolCallRequest(request)) {
        throw new Error('Invalid tool call request');
    }

    return request;
}

function parseToolArguments(args: unknown): unknown {
    return parseJsonArrays(args);
}

function asToolArguments(args: unknown): ToolArguments | undefined {
    return isRecord(args) ? args : undefined;
}

/**
 * Service responsible for creating and configuring request handlers
 * Follows SRP by focusing only on handler setup operations
 */
export class RequestHandlerFactory {
    constructor(
        private server: MCPSDKServer,
        private requestRouter: RequestRouter,
        private onToolCall?: ToolCallHook
    ) {}

    /**
     * Initialize all request handlers
     */
    initializeHandlers(): void {
        this.setupResourceHandlers();
        this.setupPromptHandlers();
        this.setupToolHandlers();
    }

    /**
     * Setup resource request handlers
     */
    private setupResourceHandlers(): void {
        // Handle resource listing
        this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
            return await this.requestRouter.handleRequest('resources/list', request) as MCPResult;
        });

        // Handle resource reading
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            return await this.requestRouter.handleRequest('resources/read', request) as MCPResult;
        });
    }

    /**
     * Setup prompt request handlers
     */
    private setupPromptHandlers(): void {
        // Handle prompts listing
        this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
            return await this.requestRouter.handleRequest('prompts/list', request) as MCPResult;
        });

        // Handle prompts get
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            return await this.requestRouter.handleRequest('prompts/get', request) as MCPResult;
        });
    }

    /**
     * Setup tool request handlers
     */
    private setupToolHandlers(): void {
        // Handle tool listing
        this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
            try {
                return await this.requestRouter.handleRequest('tools/list', request) as MCPResult;
            } catch (error) {
                console.error("Error in tool list handler:", error);
                logger.systemError(error as Error, 'Tool List Handler');
                // Return empty list in case of error to avoid timeout
                return { tools: [] };
            }
        });

        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return await this.handleToolCall(request);
        });
    }

    /**
     * Handle tool call with preprocessing
     */
    private async handleToolCall(request: unknown): Promise<MCPResult> {
        const toolRequest = getToolCallRequest(request);
        const parsedArgs = parseToolArguments(toolRequest.params.arguments);
        const parsedToolArgs = asToolArguments(parsedArgs);
        
        // Trigger tool call hook for lazy loading
        await this.triggerToolCallHook(toolRequest.params.name, parsedArgs);
        
        // Check if this is a help request
        if (this.isHelpRequest(parsedToolArgs)) {
            return await this.handleHelpRequest(toolRequest, parsedArgs);
        }
        
        // Normal execution
        return await this.handleNormalExecution(toolRequest, parsedArgs);
    }

    /**
     * Trigger tool call hook if available
     */
    private async triggerToolCallHook(toolName: string, params: unknown): Promise<void> {
        if (!this.onToolCall) {
            return;
        }

        try {
            await this.onToolCall(toolName, params);
        } catch {
            return;
        }
    }

    /**
     * Check if this is a help request
     */
    private isHelpRequest(parsedArgs: ToolArguments | undefined): boolean {
        return parsedArgs?.help === true;
    }

    /**
     * Handle help request
     */
    private async handleHelpRequest(request: ToolCallRequest, parsedArgs: unknown): Promise<MCPResult> {
        return await this.requestRouter.handleRequest('tools/help', {
            ...request,
            params: {
                ...request.params,
                arguments: parsedArgs
            }
        }) as MCPResult;
    }

    /**
     * Handle normal tool execution
     */
    private async handleNormalExecution(request: ToolCallRequest, parsedArgs: unknown): Promise<MCPResult> {
        return await this.requestRouter.handleRequest('tools/call', {
            ...request,
            params: {
                ...request.params,
                arguments: parsedArgs
            }
        }) as MCPResult;
    }

    /**
     * Get handler statistics
     */
    getHandlerStatistics(): {
        totalHandlers: number;
        handlerTypes: string[];
        resourceHandlers: number;
        promptHandlers: number;
        toolHandlers: number;
    } {
        return {
            totalHandlers: 6,
            handlerTypes: ['resources', 'prompts', 'tools'],
            resourceHandlers: 2,
            promptHandlers: 2,
            toolHandlers: 2
        };
    }

    /**
     * Validate handler setup
     */
    validateHandlerSetup(): {
        isValid: boolean;
        errors: string[];
        warnings: string[];
    } {
        const errors: string[] = [];
        const warnings: string[] = [];

        if (!this.server) {
            errors.push('Server instance not provided');
        }

        if (!this.requestRouter) {
            errors.push('Request router not provided');
        }

        if (!this.onToolCall) {
            warnings.push('No tool call hook provided');
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * Get request handler info
     */
    getRequestHandlerInfo(): Array<{
        schema: string;
        route: string;
        description: string;
        hasCustomLogic: boolean;
    }> {
        return [
            {
                schema: 'ListResourcesRequestSchema',
                route: 'resources/list',
                description: 'List available resources',
                hasCustomLogic: false
            },
            {
                schema: 'ReadResourceRequestSchema',
                route: 'resources/read',
                description: 'Read specific resource',
                hasCustomLogic: false
            },
            {
                schema: 'ListPromptsRequestSchema',
                route: 'prompts/list',
                description: 'List available prompts',
                hasCustomLogic: false
            },
            {
                schema: 'GetPromptRequestSchema',
                route: 'prompts/get',
                description: 'Get specific prompt',
                hasCustomLogic: false
            },
            {
                schema: 'ListToolsRequestSchema',
                route: 'tools/list',
                description: 'List available tools',
                hasCustomLogic: true
            },
            {
                schema: 'CallToolRequestSchema',
                route: 'tools/call',
                description: 'Execute tool',
                hasCustomLogic: true
            }
        ];
    }
}