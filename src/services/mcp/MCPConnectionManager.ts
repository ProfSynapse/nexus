import { App, Events, Plugin } from 'obsidian';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { MCPServer } from '../../server';
import { logger } from '../../utils/logger';
import { SessionContextManager } from '../SessionContextManager';

type TraceRecord = Record<string, unknown>;

type ToolCallParamsPayload = TraceRecord;

type ToolCallResponsePayload = TraceRecord;

interface ServiceManagerLike {
    getServiceIfReady(serviceName: string): unknown;
}

interface ToolCallTraceServiceLike {
    captureToolCall(
        toolName: string,
        params: ToolCallParamsPayload,
        response: ToolCallResponsePayload,
        success: boolean,
        executionTime: number
    ): Promise<void>;
}

interface PluginWithServices extends Plugin {
    getService?(name: string): Promise<unknown>;
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

function isSessionContextManager(value: unknown): value is SessionContextManager {
    return value instanceof SessionContextManager;
}

function isToolCallTraceService(value: unknown): value is ToolCallTraceServiceLike {
    return typeof value === 'object'
        && value !== null
        && typeof Reflect.get(value, 'captureToolCall') === 'function';
}

function isTraceRecord(value: unknown): value is TraceRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTraceRecord(value: unknown): TraceRecord {
    return isTraceRecord(value) ? value : {};
}

/**
 * Location: src/services/mcp/MCPConnectionManager.ts
 *
 * This service manages the MCP server connection lifecycle, including:
 * - Server creation and initialization
 * - Connection handling and management
 * - Server lifecycle (start/stop/shutdown)
 *
 * Used by: MCPConnector
 * Dependencies: MCPServer, Obsidian Events, SessionContextManager
 */

export interface MCPConnectionManagerInterface {
    /**
     * Initializes MCP connection manager
     * @throws InitializationError when initialization fails
     */
    initialize(): Promise<void>;

    /**
     * Creates and configures MCP server
     * @returns Configured MCP server instance
     * @throws ServerCreationError when server creation fails
     */
    createServer(): Promise<MCPServer>;

    /**
     * Starts the MCP server
     * @throws ServerStartError when server start fails
     */
    start(): Promise<void>;

    /**
     * Stops the MCP server
     * @throws ServerStopError when server stop fails
     */
    stop(): Promise<void>;

    /**
     * Shuts down connection manager and cleans up resources
     */
    shutdown(): Promise<void>;

    /**
     * Gets current MCP server instance
     * @returns Current server instance or null if not initialized
     */
    getServer(): MCPServer | null;

    /**
     * Gets connection status information
     * @returns Connection status details
     */
    getConnectionStatus(): MCPConnectionStatus;

    /**
     * Reinitializes the request router
     * Used after agent registration changes
     */
    reinitializeRequestRouter(): void;
}

export interface MCPConnectionStatus {
    /** Whether manager is initialized */
    isInitialized: boolean;

    /** Whether server is running */
    isServerRunning: boolean;

    /** Server creation timestamp */
    serverCreatedAt?: Date;

    /** Last error encountered */
    lastError?: {
        message: string;
        timestamp: Date;
    };
}

export class MCPConnectionManager implements MCPConnectionManagerInterface {
    private server: MCPServer | null = null;
    private isInitialized = false;
    private isServerRunning = false;
    private serverCreatedAt?: Date;
    private lastError?: { message: string; timestamp: Date };
    private sessionContextManager: SessionContextManager | null = null;
    private serviceManager: ServiceManagerLike | null = null;

    constructor(
        private app: App,
        private plugin: Plugin,
        private events: Events,
        serviceManager: ServiceManagerLike | null,
        private customPromptStorage?: CustomPromptStorageService,
        private onToolCall?: (toolName: string, params: unknown) => Promise<void>,
        private onToolResponse?: (
            toolName: string,
            params: unknown,
            response: unknown,
            success: boolean,
            executionTime: number
        ) => Promise<void>
    ) {
        this.serviceManager = serviceManager;
    }

    /**
     * Lazy getter for SessionContextManager from ServiceManager
     * Ensures we use the properly initialized instance with SessionService injected
     */
    private getSessionContextManagerFromService(): SessionContextManager {
        if (!this.sessionContextManager) {
            if (!this.serviceManager) {
                throw new Error('[MCPConnectionManager] ServiceManager not available - cannot get SessionContextManager');
            }

            const sessionContextManager = this.serviceManager.getServiceIfReady('sessionContextManager');
            if (!isSessionContextManager(sessionContextManager)) {
                throw new Error('[MCPConnectionManager] SessionContextManager not available from ServiceManager');
            }

            this.sessionContextManager = sessionContextManager;
        }

        return this.sessionContextManager;
    }

    /**
     * Initializes MCP connection manager
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            await this.initializeToolCallTracing();
            this.server = await this.createServer();
            this.isInitialized = true;

            logger.systemLog('MCP Connection Manager initialized successfully');
        } catch (error) {
            const normalizedError = toError(error, 'Failed to initialize MCP connection manager');
            this.lastError = {
                message: normalizedError.message,
                timestamp: new Date()
            };

            logger.systemError(normalizedError, 'MCP Connection Manager Initialization');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to initialize MCP connection manager',
                error
            );
        }
    }

    /**
     * Initialize tool call tracing by wrapping onToolResponse callback
     */
    private async initializeToolCallTracing(): Promise<void> {
        try {
            const pluginWithServices = this.plugin as PluginWithServices;
            if (!pluginWithServices.getService) {
                logger.systemWarn('Plugin does not support getService - tool call tracing disabled');
                return;
            }

            const toolCallTraceService = await pluginWithServices.getService('toolCallTraceService');
            if (!isToolCallTraceService(toolCallTraceService)) {
                logger.systemWarn('ToolCallTraceService not available - tool call tracing disabled');
                return;
            }

            const originalOnToolResponse = this.onToolResponse;
            this.onToolResponse = async (toolName, params, response, success, executionTime) => {
                if (originalOnToolResponse) {
                    await originalOnToolResponse(toolName, params, response, success, executionTime);
                }

                await toolCallTraceService.captureToolCall(
                    toolName,
                    toTraceRecord(params),
                    toTraceRecord(response),
                    success,
                    executionTime
                );
            };

            logger.systemLog('Tool call tracing initialized successfully');
        } catch (error) {
            logger.systemWarn(
                'Failed to initialize tool call tracing: '
                + toError(error, 'Unknown tracing initialization error').message
            );
        }
    }

    /**
     * Creates and configures MCP server
     */
    async createServer(): Promise<MCPServer> {
        try {
            const server = new MCPServer(
                this.app,
                this.plugin,
                this.events,
                this.getSessionContextManagerFromService(),
                undefined,
                this.customPromptStorage,
                this.onToolCall,
                this.onToolResponse
            );

            this.serverCreatedAt = new Date();
            logger.systemLog('MCP Server created successfully');

            return server;
        } catch (error) {
            const normalizedError = toError(error, 'Failed to create MCP server');
            this.lastError = {
                message: normalizedError.message,
                timestamp: new Date()
            };

            logger.systemError(normalizedError, 'MCP Server Creation');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to create MCP server',
                error
            );
        }
    }

    /**
     * Starts the MCP server
     */
    async start(): Promise<void> {
        if (!this.server) {
            logger.systemError(new Error('Server not initialized'), 'Cannot start server: server not initialized');
            throw new McpError(
                ErrorCode.InternalError,
                'Cannot start server: server not initialized'
            );
        }

        try {
            await this.server.start();
            this.isServerRunning = true;

            logger.systemLog('MCP Server started successfully');
        } catch (error) {
            const normalizedError = toError(error, 'Failed to start MCP server');
            this.lastError = {
                message: normalizedError.message,
                timestamp: new Date()
            };

            logger.systemError(normalizedError, 'MCP Server Start');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to start MCP server',
                error
            );
        }
    }

    /**
     * Stops the MCP server
     */
    async stop(): Promise<void> {
        if (!this.server) {
            return;
        }

        try {
            await this.server.stop();
            this.isServerRunning = false;

            logger.systemLog('MCP Server stopped successfully');
        } catch (error) {
            const normalizedError = toError(error, 'Failed to stop MCP server');
            this.lastError = {
                message: normalizedError.message,
                timestamp: new Date()
            };

            logger.systemError(normalizedError, 'MCP Server Stop');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to stop MCP server',
                error
            );
        }
    }

    /**
     * Shuts down connection manager and cleans up resources
     */
    async shutdown(): Promise<void> {
        try {
            if (this.isServerRunning) {
                await this.stop();
            }

            this.server = null;
            this.isInitialized = false;
            this.isServerRunning = false;
            this.serverCreatedAt = undefined;
            this.lastError = undefined;

            logger.systemLog('MCP Connection Manager shut down successfully');
        } catch (error) {
            const normalizedError = toError(error, 'Failed to shutdown MCP connection manager');
            this.lastError = {
                message: normalizedError.message,
                timestamp: new Date()
            };

            logger.systemError(normalizedError, 'MCP Connection Manager Shutdown');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to shutdown MCP connection manager',
                error
            );
        }
    }

    /**
     * Gets current MCP server instance
     */
    getServer(): MCPServer | null {
        return this.server;
    }

    /**
     * Gets connection status information
     */
    getConnectionStatus(): MCPConnectionStatus {
        return {
            isInitialized: this.isInitialized,
            isServerRunning: this.isServerRunning,
            serverCreatedAt: this.serverCreatedAt,
            lastError: this.lastError
        };
    }

    /**
     * Reinitializes the request router
     */
    reinitializeRequestRouter(): void {
        if (!this.server) {
            logger.systemWarn('Cannot reinitialize request router: server not initialized');
            return;
        }

        try {
            this.server.reinitializeRequestRouter();
            logger.systemLog('Request router reinitialized successfully');
        } catch (error) {
            logger.systemError(toError(error, 'Failed to reinitialize request router'), 'Request Router Reinitialization');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to reinitialize request router',
                error
            );
        }
    }
}
