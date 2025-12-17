import { App, Plugin, Events } from 'obsidian';
import { MCPServer } from '../../server';
import { SessionContextManager } from '../SessionContextManager';
import { CustomPromptStorageService } from "../../agents/agentManager/services/CustomPromptStorageService";
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger';

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
    private serviceManager: any = null;

    constructor(
        private app: App,
        private plugin: Plugin,
        private events: Events,
        serviceManager: any,
        private customPromptStorage?: CustomPromptStorageService,
        private onToolCall?: (toolName: string, params: any) => Promise<void>,
        private onToolResponse?: (toolName: string, params: any, response: any, success: boolean, executionTime: number) => Promise<void>
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

            this.sessionContextManager = this.serviceManager.getServiceIfReady('sessionContextManager');

            if (!this.sessionContextManager) {
                throw new Error('[MCPConnectionManager] SessionContextManager not available from ServiceManager');
            }
        }
        return this.sessionContextManager;
    }

    /**
     * Initializes MCP connection manager
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return; // Already initialized
        }

        try {
            // Wire up ToolCallTraceService to onToolResponse callback
            await this.initializeToolCallTracing();

            // Create the MCP server
            this.server = await this.createServer();
            this.isInitialized = true;

            logger.systemLog('MCP Connection Manager initialized successfully');
        } catch (error) {
            this.lastError = {
                message: (error as Error).message,
                timestamp: new Date()
            };

            logger.systemError(error as Error, 'MCP Connection Manager Initialization');
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
            // Get ToolCallTraceService from service manager
            const pluginWithServices = this.plugin as Plugin & { getService?: (name: string) => Promise<unknown> };
            if (!pluginWithServices.getService) {
                logger.systemWarn('Plugin does not support getService - tool call tracing disabled');
                return;
            }

            const toolCallTraceService = await pluginWithServices.getService('toolCallTraceService') as { captureToolCall: (toolName: string, params: unknown, response: unknown, success: boolean, executionTime: number) => Promise<void> } | null;
            if (!toolCallTraceService) {
                logger.systemWarn('ToolCallTraceService not available - tool call tracing disabled');
                return;
            }

            // Wrap the existing onToolResponse callback to include tracing
            const originalOnToolResponse = this.onToolResponse;
            this.onToolResponse = async (toolName, params, response, success, executionTime) => {
                // Call original callback first (if exists)
                if (originalOnToolResponse) {
                    await originalOnToolResponse(toolName, params, response, success, executionTime);
                }

                // Capture tool call trace (non-blocking, errors handled internally)
                await toolCallTraceService.captureToolCall(toolName, params, response, success, executionTime);
            };

            logger.systemLog('Tool call tracing initialized successfully');
        } catch (error) {
            // Don't throw - tracing is optional
            logger.systemWarn('Failed to initialize tool call tracing: ' + (error as Error).message);
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
                undefined, // serviceContainer will be set later if needed
                this.customPromptStorage,
                this.onToolCall,
                this.onToolResponse
            );

            this.serverCreatedAt = new Date();
            
            logger.systemLog('MCP Server created successfully');
            return server;
        } catch (error) {
            this.lastError = {
                message: (error as Error).message,
                timestamp: new Date()
            };
            
            logger.systemError(error as Error, 'MCP Server Creation');
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
            this.lastError = {
                message: (error as Error).message,
                timestamp: new Date()
            };
            
            logger.systemError(error as Error, 'MCP Server Start');
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
            return; // No server to stop
        }

        try {
            await this.server.stop();
            this.isServerRunning = false;
            
            logger.systemLog('MCP Server stopped successfully');
        } catch (error) {
            this.lastError = {
                message: (error as Error).message,
                timestamp: new Date()
            };
            
            logger.systemError(error as Error, 'MCP Server Stop');
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
            this.lastError = {
                message: (error as Error).message,
                timestamp: new Date()
            };
            
            logger.systemError(error as Error, 'MCP Connection Manager Shutdown');
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
            logger.systemError(error as Error, 'Request Router Reinitialization');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to reinitialize request router',
                error
            );
        }
    }
}