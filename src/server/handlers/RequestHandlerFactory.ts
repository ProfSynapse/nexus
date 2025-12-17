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
    GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { RequestRouter } from '../../handlers/RequestRouter';
import { parseJsonArrays } from '../../utils/jsonUtils';
import { logger } from '../../utils/logger';

/**
 * Service responsible for creating and configuring request handlers
 * Follows SRP by focusing only on handler setup operations
 */
export class RequestHandlerFactory {
    constructor(
        private server: MCPSDKServer,
        private requestRouter: RequestRouter,
        private onToolCall?: (toolName: string, params: any) => Promise<void>
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
            return await this.requestRouter.handleRequest('resources/list', request);
        });

        // Handle resource reading
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            return await this.requestRouter.handleRequest('resources/read', request);
        });
    }

    /**
     * Setup prompt request handlers
     */
    private setupPromptHandlers(): void {
        // Handle prompts listing
        this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
            return await this.requestRouter.handleRequest('prompts/list', request);
        });

        // Handle prompts get
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            return await this.requestRouter.handleRequest('prompts/get', request);
        });
    }

    /**
     * Setup tool request handlers
     */
    private setupToolHandlers(): void {
        // Handle tool listing
        this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
            try {
                return await this.requestRouter.handleRequest('tools/list', request);
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
    private async handleToolCall(request: any): Promise<any> {
        const parsedArgs = parseJsonArrays(request.params.arguments);
        
        // Trigger tool call hook for lazy loading
        await this.triggerToolCallHook(request.params.name, parsedArgs);
        
        // Check if this is a help request
        if (this.isHelpRequest(parsedArgs)) {
            return await this.handleHelpRequest(request, parsedArgs);
        }
        
        // Normal execution
        return await this.handleNormalExecution(request, parsedArgs);
    }

    /**
     * Trigger tool call hook if available
     */
    private async triggerToolCallHook(toolName: string, params: any): Promise<void> {
        if (!this.onToolCall) {
            return;
        }

        try {
            await this.onToolCall(toolName, params);
        } catch (error) {
        }
    }

    /**
     * Check if this is a help request
     */
    private isHelpRequest(parsedArgs: any): boolean {
        return parsedArgs && parsedArgs.help === true;
    }

    /**
     * Handle help request
     */
    private async handleHelpRequest(request: any, parsedArgs: any): Promise<any> {
        return await this.requestRouter.handleRequest('tools/help', {
            ...request,
            params: {
                ...request.params,
                arguments: parsedArgs
            }
        });
    }

    /**
     * Handle normal tool execution
     */
    private async handleNormalExecution(request: any, parsedArgs: any): Promise<any> {
        return await this.requestRouter.handleRequest('tools/call', {
            ...request,
            params: {
                ...request.params,
                arguments: parsedArgs
            }
        });
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