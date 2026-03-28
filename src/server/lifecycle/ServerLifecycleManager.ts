/**
 * ServerLifecycleManager - Handles server lifecycle operations
 * Follows Single Responsibility Principle by focusing only on lifecycle management
 */

import { Events } from 'obsidian';
import { AgentRegistry } from '../services/AgentRegistry';
import { HttpTransportManager } from '../transport/HttpTransportManager';
import { IPCTransportManager } from '../transport/IPCTransportManager';
import { ServerStatus } from '../../types';
import { logger } from '../../utils/logger';

type AgentStatistics = ReturnType<AgentRegistry['getAgentStatistics']>;
type HttpTransportStatus = ReturnType<HttpTransportManager['getTransportStatus']>;
type IpcTransportStatus = ReturnType<IPCTransportManager['getTransportStatus']>;
type IpcDiagnostics = ReturnType<IPCTransportManager['getDiagnostics']>;

interface DetailedServerStatus {
    status: ServerStatus;
    isRunning: boolean;
    agentCount: number;
    httpTransportStatus: HttpTransportStatus;
    ipcTransportStatus: IpcTransportStatus;
    uptime?: number;
}

interface ServerHealthCheck {
    isHealthy: boolean;
    status: ServerStatus;
    agentStatus: AgentStatistics;
    transportStatus: {
        http: HttpTransportStatus;
        ipc: IpcTransportStatus;
    };
    issues: string[];
}

interface ServerDiagnostics {
    lifecycle: {
        status: ServerStatus;
        isRunning: boolean;
        isInError: boolean;
    };
    agents: AgentStatistics;
    transports: {
        http: HttpTransportStatus;
        ipc: IpcDiagnostics;
    };
    events: {
        hasEvents: boolean;
    };
}

/**
 * Service responsible for server lifecycle management
 * Follows SRP by focusing only on lifecycle operations
 */
export class ServerLifecycleManager {
    private status: ServerStatus = 'stopped';

    constructor(
        private agentRegistry: AgentRegistry,
        private httpTransportManager: HttpTransportManager,
        private ipcTransportManager: IPCTransportManager,
        private events: Events
    ) {}

    /**
     * Start the server
     */
    async startServer(): Promise<void> {
        if (this.status === 'running') {
            logger.systemWarn('Server is already running');
            return;
        }

        try {
            this.status = 'starting';
            logger.systemLog('Starting server...');

            // Initialize agents
            await this.initializeAgents();

            // Start transports
            await this.startTransports();

            this.status = 'running';
            this.events.trigger('server:started');
            logger.systemLog('Server started successfully with IPC transport');
        } catch (error) {
            this.status = 'error';
            logger.systemError(error as Error, 'Server Start');
            throw error;
        }
    }

    /**
     * Stop the server
     */
    async stopServer(): Promise<void> {
        if (this.status === 'stopped') {
            logger.systemWarn('Server is already stopped');
            return;
        }

        try {
            this.status = 'stopping';
            logger.systemLog('Stopping server...');

            // Stop transports
            await this.stopTransports();

            this.status = 'stopped';
            this.events.trigger('server:stopped');
            logger.systemLog('Server stopped successfully');
        } catch (error) {
            this.status = 'error';
            logger.systemError(error as Error, 'Server Stop');
            throw error;
        }
    }

    /**
     * Restart the server
     */
    async restartServer(): Promise<void> {
        logger.systemLog('Restarting server...');
        await this.stopServer();
        await this.startServer();
    }

    /**
     * Initialize all registered agents
     */
    private async initializeAgents(): Promise<void> {
        try {
            await this.agentRegistry.initializeAgents();
            logger.systemLog('All agents initialized successfully');
        } catch (error) {
            logger.systemError(error as Error, 'Agent Initialization');
            throw error;
        }
    }

    /**
     * Start transports
     */
    private async startTransports(): Promise<void> {
        try {
            // Start IPC transport only (used by both external clients and internal chatbot)
            await this.ipcTransportManager.startTransport();
            logger.systemLog('IPC transport started successfully');
        } catch (error) {
            logger.systemError(error as Error, 'Transport Start');
            throw error;
        }
    }

    /**
     * Stop both transports
     */
    private async stopTransports(): Promise<void> {
        try {
            // Only stop IPC transport (no HTTP to stop)
            await this.ipcTransportManager.stopTransport();

            logger.systemLog('IPC transport stopped successfully');
        } catch (error) {
            logger.systemError(error as Error, 'Transport Stop');
            throw error;
        }
    }

    /**
     * Get current server status
     */
    getStatus(): ServerStatus {
        return this.status;
    }

    /**
     * Check if server is running
     */
    isRunning(): boolean {
        return this.status === 'running';
    }

    /**
     * Check if server is in error state
     */
    isInError(): boolean {
        return this.status === 'error';
    }

    /**
     * Get detailed server status
     */
    getDetailedStatus(): DetailedServerStatus {
        return {
            status: this.status,
            isRunning: this.isRunning(),
            agentCount: this.agentRegistry.getAgentCount(),
            ipcTransportStatus: this.ipcTransportManager.getTransportStatus(),
            httpTransportStatus: this.httpTransportManager.getTransportStatus()
        };
    }

    /**
     * Handle server error
     */
    handleServerError(error: Error): void {
        logger.systemError(error, 'Server Error');
        this.status = 'error';
        this.events.trigger('server:error', error);
    }

    /**
     * Perform health check
     */
    async performHealthCheck(): Promise<ServerHealthCheck> {
        const issues: string[] = [];

        // Check status
        if (this.status !== 'running') {
            issues.push(`Server status is ${this.status}, expected 'running'`);
        }

        // Check agents
        const agentStats = this.agentRegistry.getAgentStatistics();
        if (agentStats.totalAgents === 0) {
            issues.push('No agents registered');
        }

        // Check transports
        const httpStatus = this.httpTransportManager.getTransportStatus();
        const ipcStatus = this.ipcTransportManager.getTransportStatus();

        if (!httpStatus.isRunning) {
            issues.push('STDIO transport not connected');
        }

        if (!ipcStatus.isRunning) {
            issues.push('IPC transport not running');
        }

        return {
            isHealthy: issues.length === 0,
            status: this.status,
            agentStatus: agentStats,
            transportStatus: {
                http: httpStatus,
                ipc: ipcStatus
            },
            issues
        };
    }

    /**
     * Get server diagnostics
     */
    async getDiagnostics(): Promise<ServerDiagnostics> {
        return {
            lifecycle: {
                status: this.status,
                isRunning: this.isRunning(),
                isInError: this.isInError()
            },
            agents: this.agentRegistry.getAgentStatistics(),
            transports: {
                http: this.httpTransportManager.getTransportStatus(),
                ipc: this.ipcTransportManager.getDiagnostics()
            },
            events: {
                hasEvents: !!this.events
            }
        };
    }

    /**
     * Force shutdown (emergency stop)
     */
    async forceShutdown(): Promise<void> {
        logger.systemWarn('Force shutdown initiated');
        
        try {
            // Try to stop transports gracefully first
            await Promise.race([
                this.stopTransports(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Transport shutdown timeout')), 5000)
                )
            ]);
        } catch (error) {
            logger.systemError(error as Error, 'Force Shutdown - Transport Stop');
        }

        // Force cleanup
        try {
            await this.ipcTransportManager.forceCleanupSocket();
        } catch (error) {
            logger.systemError(error as Error, 'Force Shutdown - Socket Cleanup');
        }

        this.status = 'stopped';
        this.events.trigger('server:force-shutdown');
        logger.systemWarn('Force shutdown completed');
    }
}