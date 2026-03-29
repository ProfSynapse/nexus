/**
 * StdioTransportManager - Handles STDIO transport management
 * Follows Single Responsibility Principle by focusing only on STDIO transport
 */

import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger';

/**
 * Service responsible for STDIO transport management
 * Follows SRP by focusing only on STDIO transport operations
 */
export class StdioTransportManager {
    private stdioTransport: StdioServerTransport | null = null;
    private isConnected: boolean = false;
    /** The most recently connected socket-based transport (IPC connections). */
    private activeSocketTransport: StdioServerTransport | null = null;

    constructor(private server: MCPSDKServer) {}

    /**
     * Start the STDIO transport
     */
    async startTransport(): Promise<StdioServerTransport> {
        if (this.stdioTransport) {
            return this.stdioTransport;
        }

        try {
            const transport = new StdioServerTransport();
            
            await this.server.connect(transport);
            
            this.stdioTransport = transport;
            this.isConnected = true;
            
            logger.systemLog('STDIO transport started successfully');
            
            return transport;
        } catch (error) {
            logger.systemError(error as Error, 'STDIO Transport Start');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to start STDIO transport',
                error
            );
        }
    }

    /**
     * Stop the STDIO transport
     */
    async stopTransport(): Promise<void> {
        if (!this.stdioTransport) {
            return;
        }

        try {
            await this.stdioTransport.close();
            this.stdioTransport = null;
            this.isConnected = false;
            
            logger.systemLog('STDIO transport stopped successfully');
        } catch (error) {
            logger.systemError(error as Error, 'STDIO Transport Stop');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to stop STDIO transport',
                error
            );
        }
    }

    /**
     * Check if the transport is connected
     */
    isTransportConnected(): boolean {
        return this.isConnected && this.stdioTransport !== null;
    }

    /**
     * Get the transport instance
     */
    getTransport(): StdioServerTransport | null {
        return this.stdioTransport;
    }

    /**
     * Restart the transport
     */
    async restartTransport(): Promise<StdioServerTransport> {
        await this.stopTransport();
        return await this.startTransport();
    }

    /**
     * Get transport status
     */
    getTransportStatus(): {
        isConnected: boolean;
        hasTransport: boolean;
        transportType: string;
    } {
        return {
            isConnected: this.isConnected,
            hasTransport: this.stdioTransport !== null,
            transportType: 'stdio'
        };
    }

    /**
     * Create a new transport instance (for socket connections)
     */
    createSocketTransport(inputStream: any, outputStream: any): StdioServerTransport {
        return new StdioServerTransport(inputStream, outputStream);
    }

    /**
     * Connect a socket transport to the server
     *
     * If a previous socket transport is still active (e.g. the old socket's
     * close/end event hasn't fired yet), close it first so that
     * Protocol._transport is cleared before we call server.connect().
     */
    async connectSocketTransport(transport: StdioServerTransport): Promise<void> {
        // Proactively close the previous socket transport to avoid the
        // "Already connected to a transport" race: a new connection can
        // arrive before the old socket's async close/end handler runs.
        if (this.activeSocketTransport) {
            try {
                await this.activeSocketTransport.close();
            } catch {
                // Transport may already be closed — safe to ignore.
            }
            this.activeSocketTransport = null;
        }

        try {
            await this.server.connect(transport);
            this.activeSocketTransport = transport;
            logger.systemLog('Socket transport connected successfully');
        } catch (error) {
            this.activeSocketTransport = null;
            logger.systemError(error as Error, 'Socket Transport Connection');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to connect socket transport',
                error
            );
        }
    }

    /**
     * Handle transport errors
     */
    handleTransportError(error: Error): void {
        logger.systemError(error, 'STDIO Transport Error');
        
        // Reset connection state
        this.isConnected = false;
        
        // Attempt to clean up
        if (this.stdioTransport) {
            try {
                this.stdioTransport.close().catch(closeError => {
                    logger.systemError(closeError as Error, 'Transport Error Cleanup');
                });
            } catch (cleanupError) {
                logger.systemError(cleanupError as Error, 'Transport Error Cleanup');
            }
        }
    }

    /**
     * Get transport diagnostics
     */
    getDiagnostics(): {
        transportType: string;
        isConnected: boolean;
        hasTransport: boolean;
        lastError?: string;
    } {
        return {
            transportType: 'stdio',
            isConnected: this.isConnected,
            hasTransport: this.stdioTransport !== null
        };
    }
}