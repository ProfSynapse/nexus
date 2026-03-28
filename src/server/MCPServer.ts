/**
 * MCPServer - Refactored following SOLID principles
 * Main orchestrator for MCP server operations
 */

import { App, Plugin, Events } from 'obsidian';
import { IMCPServer, ServerStatus } from '../types';
import { IAgent } from '../agents/interfaces/IAgent';
import { SessionContextManager } from '../services/SessionContextManager';
import { CustomPromptStorageService } from "../agents/promptManager/services/CustomPromptStorageService";
import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { RequestRouter } from '../handlers/RequestRouter';
import { logger } from '../utils/logger';

// Import specialized services
import { ServerConfiguration } from './services/ServerConfiguration';
import { AgentRegistry } from './services/AgentRegistry';
import { HttpTransportManager } from './transport/HttpTransportManager';
import { IPCTransportManager } from './transport/IPCTransportManager';
import { StdioTransportManager } from './transport/StdioTransportManager';
import { RequestHandlerFactory } from './handlers/RequestHandlerFactory';
import { ServerLifecycleManager } from './lifecycle/ServerLifecycleManager';
import { AgentExecutionManager } from './execution/AgentExecutionManager';

type ToolCallCallback = (toolName: string, params: unknown) => Promise<void>;
type ToolResponseCallback = (
    toolName: string,
    params: unknown,
    response: unknown,
    success: boolean,
    executionTime: number
) => Promise<void>;

type ServerConfigurationSummary = ReturnType<ServerConfiguration['getConfigurationSummary']>;
type ServerDiagnostics = Awaited<ReturnType<ServerLifecycleManager['getDiagnostics']>>;
type ServerHealthCheck = Awaited<ReturnType<ServerLifecycleManager['performHealthCheck']>>;
type ExecutionStatistics = ReturnType<AgentExecutionManager['getExecutionStatistics']>;
type RequestHandlerStatistics = ReturnType<RequestHandlerFactory['getHandlerStatistics']>;
type DetailedServerStatus = ReturnType<ServerLifecycleManager['getDetailedStatus']>;
type AgentStatistics = ReturnType<AgentRegistry['getAgentStatistics']>;
type HttpTransportStatus = ReturnType<HttpTransportManager['getTransportStatus']>;
type IpcTransportStatus = ReturnType<IPCTransportManager['getTransportStatus']>;
type ExecutionValidationParameters = Parameters<AgentExecutionManager['validateExecutionParameters']>[2];
type ExecutionValidationResult = ReturnType<AgentExecutionManager['validateExecutionParameters']>;
type ExecutionContextInfo = ReturnType<AgentExecutionManager['getExecutionContextInfo']>;

type ConfigurationUpdates = {
    capabilities?: Record<string, unknown>;
};

type MCPServerInfo = {
    configuration: ServerConfigurationSummary;
    status: DetailedServerStatus;
    agents: AgentStatistics;
    transports: {
        http: HttpTransportStatus;
        ipc: IpcTransportStatus;
    };
    handlers: RequestHandlerStatistics;
    execution: ExecutionStatistics;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isConfigurationUpdates(value: unknown): value is ConfigurationUpdates {
    if (!isRecord(value)) {
        return false;
    }

    return value.capabilities === undefined || isRecord(value.capabilities);
}

/**
 * Refactored MCP Server following SOLID principles
 * Orchestrates specialized services for server operations
 */
export class MCPServer implements IMCPServer {
    // Core SDK server
    private server: MCPSDKServer;
    
    // Specialized services following Dependency Injection principle
    private configuration: ServerConfiguration;
    private agentRegistry: AgentRegistry;
    private httpTransportManager: HttpTransportManager;
    private stdioTransportManager: StdioTransportManager;
    private ipcTransportManager: IPCTransportManager;
    private requestHandlerFactory: RequestHandlerFactory;
    private lifecycleManager: ServerLifecycleManager;
    private executionManager: AgentExecutionManager;
    
    // Request routing
    private requestRouter!: RequestRouter;

    constructor(
        private app: App,
        _plugin: Plugin,
        private events: Events,
        private sessionContextManager?: SessionContextManager,
        serverName?: string,
        private customPromptStorage?: CustomPromptStorageService,
        private onToolCall?: ToolCallCallback,
        private onToolResponse?: ToolResponseCallback
    ) {
        // Initialize configuration service
        this.configuration = new ServerConfiguration(app, { serverName });
        
        // Initialize core SDK server
        this.server = this.createMCPSDKServer();
        
        // Initialize specialized services
        this.agentRegistry = new AgentRegistry();
        this.httpTransportManager = new HttpTransportManager(this.server, 3000, 'localhost');
        this.stdioTransportManager = new StdioTransportManager(this.server);
        this.ipcTransportManager = new IPCTransportManager(
            this.configuration,
            this.stdioTransportManager,
            () => this.createPerConnectionServer()
        );
        this.executionManager = new AgentExecutionManager(this.agentRegistry, sessionContextManager);

        // Initialize request routing
        this.initializeRequestRouter();
        
        // Initialize request handlers
        this.requestHandlerFactory = new RequestHandlerFactory(
            this.server,
            this.requestRouter,
            this.onToolCall
        );
        
        // Initialize lifecycle manager
        this.lifecycleManager = new ServerLifecycleManager(
            this.agentRegistry,
            this.httpTransportManager,
            this.ipcTransportManager,
            this.events
        );
        
        // Setup handlers
        this.requestHandlerFactory.initializeHandlers();
    }

    /**
     * Create the MCP SDK server instance
     */
    private createMCPSDKServer(): MCPSDKServer {
        try {
            return new MCPSDKServer(
                this.configuration.getServerInfo(),
                this.configuration.getServerOptions()
            );
        } catch (error) {
            logger.systemError(error as Error, 'MCP SDK Server Creation');
            throw error;
        }
    }

    /**
     * Create a fully-configured MCPSDKServer for a single IPC connection.
     *
     * Each IPC socket gets its own Protocol instance so multiple clients
     * (Claude Desktop, Cursor, etc.) can connect simultaneously without
     * the "Already connected to a transport" conflict.
     */
    createPerConnectionServer(): MCPSDKServer {
        const server = new MCPSDKServer(
            this.configuration.getServerInfo(),
            this.configuration.getServerOptions()
        );
        const handlers = new RequestHandlerFactory(
            server,
            this.requestRouter,
            this.onToolCall
        );
        handlers.initializeHandlers();
        return server;
    }

    /**
     * Initialize the request router
     */
    private initializeRequestRouter(): void {
        try {
            this.requestRouter = new RequestRouter(
                this.app,
                this.agentRegistry.getAgents(),
                true, // isVaultEnabled
                this.configuration.getSanitizedVaultName(),
                this.sessionContextManager,
                this.customPromptStorage,
                this.onToolResponse
            );
        } catch (error) {
            logger.systemError(error as Error, 'Request Router Initialization');
            throw error;
        }
    }

    /**
     * Start the MCP server
     */
    async start(): Promise<void> {
        await this.lifecycleManager.startServer();
    }

    /**
     * Stop the MCP server
     */
    async stop(): Promise<void> {
        await this.lifecycleManager.stopServer();
    }

    /**
     * Check if the server is running
     */
    isRunning(): boolean {
        return this.lifecycleManager.isRunning();
    }

    /**
     * Get the current server status
     */
    getStatus(): ServerStatus {
        return this.lifecycleManager.getStatus();
    }

    /**
     * Register an agent with the server
     */
    registerAgent(agent: IAgent): void {
        this.agentRegistry.registerAgent(agent);
    }

    /**
     * Get an agent by name
     */
    getAgent(name: string): IAgent {
        return this.agentRegistry.getAgent(name);
    }

    /**
     * Get all registered agents
     */
    getAgents(): Map<string, IAgent> {
        return this.agentRegistry.getAgents();
    }

    /**
     * Get server configuration summary
     */
    getConfigurationSummary(): ServerConfigurationSummary {
        return this.configuration.getConfigurationSummary();
    }

    /**
     * Get server diagnostics
     */
    getDiagnostics(): Promise<ServerDiagnostics> {
        return this.lifecycleManager.getDiagnostics();
    }

    /**
     * Perform health check
     */
    performHealthCheck(): Promise<ServerHealthCheck> {
        return this.lifecycleManager.performHealthCheck();
    }

    /**
     * Get execution statistics
     */
    getExecutionStatistics(): ExecutionStatistics {
        return this.executionManager.getExecutionStatistics();
    }

    /**
     * Get request handler statistics
     */
    getRequestHandlerStatistics(): RequestHandlerStatistics {
        return this.requestHandlerFactory.getHandlerStatistics();
    }

    /**
     * Restart the server
     */
    async restart(): Promise<void> {
        await this.lifecycleManager.restartServer();
    }

    /**
     * Force shutdown (emergency stop)
     */
    async forceShutdown(): Promise<void> {
        await this.lifecycleManager.forceShutdown();
    }

    /**
     * Get detailed server status
     */
    getDetailedStatus(): DetailedServerStatus {
        return this.lifecycleManager.getDetailedStatus();
    }

    /**
     * Get agent statistics
     */
    getAgentStatistics(): AgentStatistics {
        return this.agentRegistry.getAgentStatistics();
    }

    /**
     * Get transport status
     */
    getTransportStatus(): {
        http: HttpTransportStatus;
        ipc: IpcTransportStatus;
    } {
        return {
            http: this.httpTransportManager.getTransportStatus(),
            ipc: this.ipcTransportManager.getTransportStatus()
        };
    }

    /**
     * Get HTTP server URL for MCP integration
     */
    getServerUrl(): string {
        return this.httpTransportManager.getServerUrl();
    }

    /**
     * Validate execution parameters
     */
    validateExecutionParameters(
        agentName: string,
        mode: string,
        params: ExecutionValidationParameters
    ): ExecutionValidationResult {
        return this.executionManager.validateExecutionParameters(agentName, mode, params);
    }

    /**
     * Get execution context info
     */
    getExecutionContextInfo(sessionId?: string): ExecutionContextInfo {
        return this.executionManager.getExecutionContextInfo(sessionId);
    }

    /**
     * Update server configuration
     */
    updateConfiguration(updates: unknown): void {
        if (!isConfigurationUpdates(updates) || updates.capabilities === undefined) {
            return;
        }

        if (isRecord(updates.capabilities)) {
            this.configuration.updateCapabilities(updates.capabilities);
        }
    }

    /**
     * Reinitialize request router with current agents
     * Call this after agents have been registered
     */
    reinitializeRequestRouter(): void {
        try {
            this.requestRouter = new RequestRouter(
                this.app,
                this.agentRegistry.getAgents(),
                true, // isVaultEnabled
                this.configuration.getSanitizedVaultName(),
                this.sessionContextManager,
                this.customPromptStorage,
                this.onToolResponse // Callback should be available as class property
            );
            
            // Register WorkspaceSchemaProvider after RequestRouter is created with agents
            this.requestRouter.registerWorkspaceSchemaProvider().catch(error => {
                logger.systemError(error as Error, 'WorkspaceSchemaProvider Registration');
            });
            
            // Reinitialize request handlers with new router
            this.requestHandlerFactory = new RequestHandlerFactory(
                this.server,
                this.requestRouter,
                this.onToolCall
            );
            this.requestHandlerFactory.initializeHandlers();
        } catch (error) {
            logger.systemError(error as Error, 'Request Router Reinitialization');
            throw error;
        }
    }

    /**
     * Get server info
     */
    getServerInfo(): MCPServerInfo {
        return {
            configuration: this.configuration.getConfigurationSummary(),
            status: this.getDetailedStatus(),
            agents: this.getAgentStatistics(),
            transports: this.getTransportStatus(),
            handlers: this.getRequestHandlerStatistics(),
            execution: this.getExecutionStatistics()
        };
    }
}