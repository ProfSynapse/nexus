/**
 * IPCTransportManager - Handles IPC transport management
 * Follows Single Responsibility Principle by focusing only on IPC transport
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { ServerConfiguration } from '../services/ServerConfiguration';
import { StdioTransportManager } from './StdioTransportManager';
import { logger } from '../../utils/logger';

type IPCServer = import('net').Server;
type IPCSocket = import('net').Socket;
type NetModule = typeof import('net');
type FsPromisesModule = typeof import('fs/promises');
type RejectHandler = (error: Error) => void;

/**
 * Service responsible for IPC transport management
 * Follows SRP by focusing only on IPC transport operations
 */
export class IPCTransportManager {
    private ipcServer: IPCServer | null = null;
    private isRunning: boolean = false;
    /** Per-connection MCPSDKServer instances for multi-client support. */
    private activeConnections: Set<MCPSDKServer> = new Set();
    /** Track current transport for proactive cleanup */
    private currentTransport: StdioServerTransport | null = null;

    constructor(
        private configuration: ServerConfiguration,
        private stdioTransportManager: StdioTransportManager,
        private serverFactory?: () => MCPSDKServer
    ) {}

    private getNetModule(): NetModule {
        // Desktop-only runtime dependency; keep loading deferred until transport startup.
        // eslint-disable-next-line import/no-nodejs-modules, @typescript-eslint/no-require-imports
        return require('net') as NetModule;
    }

    private getFsPromisesModule(): FsPromisesModule {
        // Desktop-only runtime dependency; keep loading deferred until transport startup.
        // eslint-disable-next-line import/no-nodejs-modules, @typescript-eslint/no-require-imports
        return require('fs/promises') as FsPromisesModule;
    }

    private toError(error: unknown, fallbackMessage: string): Error {
        if (error instanceof Error) {
            return error;
        }

        if (typeof error === 'string' && error.length > 0) {
            return new Error(error);
        }

        return new Error(fallbackMessage);
    }

    private getErrorCode(error: unknown): string | undefined {
        if (typeof error !== 'object' || error === null) {
            return undefined;
        }

        const code: unknown = Reflect.get(error, 'code');
        return typeof code === 'string' ? code : undefined;
    }

    /**
     * Start the IPC transport server
     */
    async startTransport(): Promise<IPCServer> {
        if (this.ipcServer) {
            return this.ipcServer;
        }

        const isWindows = this.configuration.isWindows();
        const ipcPath = this.configuration.getIPCPath();

        if (!isWindows) {
            await this.cleanupSocket();
        }

        const { createServer } = this.getNetModule();

        return new Promise((resolve, reject) => {
            try {
                const server = createServer((socket) => {
                    this.handleSocketConnection(socket).catch(error => {
                        const socketError = this.toError(error, 'Failed to handle IPC socket connection');
                        logger.systemError(socketError, 'IPC Socket Handling');
                        if (!socket.destroyed) {
                            socket.destroy();
                        }
                    });
                });

                this.setupServerErrorHandling(server, ipcPath, isWindows, reject);
                this.startListening(server, ipcPath, isWindows, resolve, reject);
            } catch (error) {
                const creationError = this.toError(error, 'Failed to create IPC server');
                logger.systemError(creationError, 'IPC Server Creation');
                reject(creationError);
            }
        });
    }

    /**
     * Handle new socket connections.
     *
     * When a serverFactory is provided, each IPC socket gets its own
     * MCPSDKServer (Protocol) instance.  This allows multiple clients
     * (Claude Desktop, Cursor, etc.) to be connected simultaneously
     * without "Already connected to a transport" errors.
     *
     * Falls back to the shared single-server path via StdioTransportManager
     * when no factory is available.
     *
     * Proactive cleanup: closes the previous transport BEFORE connecting the
     * new one, preventing a race where the old transport's onclose fires after
     * the new connect and nullifies Protocol._transport.
     */
    private async handleSocketConnection(socket: IPCSocket): Promise<void> {
        const createServerInstance = this.serverFactory;
        if (createServerInstance) {
            this.handleMultiClientConnection(socket, createServerInstance);
            return;
        }

        await this.handleSingleClientConnection(socket);
    }

    /**
     * Per-connection server path: create a dedicated MCPSDKServer for this
     * socket so that multiple clients can coexist.
     */
    private handleMultiClientConnection(socket: IPCSocket, createServerInstance: () => MCPSDKServer): void {
        try {
            const server = createServerInstance();
            const transport = new StdioServerTransport(socket, socket);

            const netSocket = socket;
            let closed = false;
            const onSocketGone = () => {
                if (closed) return;
                closed = true;
                logger.systemLog('IPC socket disconnected — closing per-connection server');
                this.activeConnections.delete(server);
                server.close().catch((err: Error) => {
                    logger.systemError(err, 'Per-Connection Server Close');
                });
            };
            netSocket.on('close', onSocketGone);
            netSocket.on('end', onSocketGone);

            server.connect(transport)
                .then(() => {
                    this.activeConnections.add(server);
                    logger.systemLog(`IPC socket connected successfully (${this.activeConnections.size} active)`);
                })
                .catch(error => {
                    logger.systemError(this.toError(error, 'Failed to connect IPC socket'), 'IPC Socket Connection');
                    if (!netSocket.destroyed) netSocket.destroy();
                });
        } catch (error) {
            logger.systemError(this.toError(error, 'Failed to create per-connection IPC server'), 'IPC Socket Handling');
            if (!socket.destroyed) socket.destroy();
        }
    }

    /**
     * Single-server path via StdioTransportManager (kept as fallback).
     * Wires the raw socket's lifecycle events to the MCP transport
     * so that Protocol._transport is cleared when a client disconnects.
     */
    private async handleSingleClientConnection(socket: IPCSocket): Promise<void> {
        const netSocket = socket;
        try {
            const transport = this.stdioTransportManager.createSocketTransport(socket, socket);
            let closed = false;
            const onSocketGone = () => {
                if (closed) return;
                closed = true;
                logger.systemLog('IPC socket disconnected — releasing transport');
                this.currentTransport = null;
                transport.close().catch((err: Error) => {
                    logger.systemError(err, 'IPC Transport Close on Disconnect');
                });
            };
            netSocket.on('close', onSocketGone);
            netSocket.on('end', onSocketGone);

            // Proactive cleanup: close previous transport before connecting new one
            if (this.currentTransport) {
                logger.systemLog('Proactive cleanup: closing previous transport before new connection');
                try {
                    await Promise.race([
                        this.currentTransport.close(),
                        new Promise(resolve => setTimeout(resolve, 500))
                    ]);
                } catch (err) {
                    logger.systemError(this.toError(err, 'Failed during proactive transport cleanup'), 'Proactive Transport Cleanup');
                }
                this.currentTransport = null;
            }

            await this.stdioTransportManager.connectSocketTransport(transport);
            this.currentTransport = transport;
            logger.systemLog('IPC socket connected successfully');
        } catch (error) {
            logger.systemError(this.toError(error, 'Failed to connect IPC socket transport'), 'IPC Socket Connection');
            if (!netSocket.destroyed) netSocket.destroy();
        }
    }

    /**
     * Setup server error handling
     */
    private setupServerErrorHandling(
        server: IPCServer,
        ipcPath: string,
        isWindows: boolean,
        reject: RejectHandler
    ): void {
        server.on('error', (error) => {
            const serverError = this.toError(error, 'IPC server error');
            logger.systemError(serverError, 'IPC Server');

            if (!isWindows && this.getErrorCode(error) === 'EADDRINUSE') {
                this.handleAddressInUse(server, ipcPath, reject);
            } else {
                reject(serverError);
            }
        });
    }

    /**
     * Handle address in use error
     */
    private handleAddressInUse(
        server: IPCServer,
        ipcPath: string,
        reject: RejectHandler
    ): void {
        this.cleanupSocket()
            .then(() => {
                try {
                    server.listen(ipcPath);
                } catch (listenError) {
                    const retryError = this.toError(listenError, 'Failed to retry IPC server listen');
                    logger.systemError(retryError, 'Server Listen Retry');
                    reject(retryError);
                }
            })
            .catch(cleanupError => {
                const socketCleanupError = this.toError(cleanupError, 'Failed to clean up IPC socket');
                logger.systemError(socketCleanupError, 'Socket Cleanup');
                reject(socketCleanupError);
            });
    }

    /**
     * Start listening on the IPC path
     */
    private startListening(
        server: IPCServer,
        ipcPath: string,
        isWindows: boolean,
        resolve: (server: IPCServer) => void
    ): void {
        server.listen(ipcPath, () => {
            this.handleListeningStarted(server, ipcPath, isWindows, resolve);
        });
    }

    /**
     * Handle successful listening start
     */
    private handleListeningStarted(
        server: IPCServer,
        ipcPath: string,
        isWindows: boolean,
        resolve: (server: IPCServer) => void
    ): void {
        const fsPromises = this.getFsPromisesModule();

        if (!isWindows) {
            fsPromises.chmod(ipcPath, 0o666).catch(error => {
                logger.systemError(this.toError(error, 'Failed to set IPC socket permissions'), 'Socket Permissions');
            });
        }

        this.ipcServer = server;
        this.isRunning = true;
        
        logger.systemLog(`IPC server started on path: ${ipcPath}`);
        resolve(server);
    }

    /**
     * Stop the IPC transport server and close all active connections
     */
    async stopTransport(): Promise<void> {
        if (!this.ipcServer) {
            return;
        }

        try {
            // Close all per-connection servers
            const closePromises = Array.from(this.activeConnections).map(server =>
                server.close().catch((err: Error) => {
                    logger.systemError(err, 'Per-Connection Server Close on Stop');
                })
            );
            this.activeConnections.clear();
            await Promise.all(closePromises);

            // Close active single-client transport before stopping server
            if (this.currentTransport) {
                try {
                    await this.currentTransport.close();
                } catch (err) {
                    logger.systemError(this.toError(err, 'Failed to clean up current IPC transport'), 'Transport Cleanup on Stop');
                }
                this.currentTransport = null;
            }

            this.ipcServer.close();
            this.ipcServer = null;
            this.isRunning = false;

            await this.cleanupSocket();

            logger.systemLog('IPC transport stopped successfully');
        } catch (error) {
            const stopError = this.toError(error, 'Failed to stop IPC transport');
            logger.systemError(stopError, 'IPC Transport Stop');
            throw stopError;
        }
    }

    /**
     * Clean up the socket file
     */
    private async cleanupSocket(): Promise<void> {
        if (this.configuration.isWindows()) {
            return;
        }

        const fsPromises = this.getFsPromisesModule();

        try {
            await fsPromises.unlink(this.configuration.getIPCPath());
        } catch (error) {
            // Ignore if file doesn't exist
            if (this.getErrorCode(error) !== 'ENOENT') {
                logger.systemError(this.toError(error, 'Failed to clean up IPC socket'), 'Socket Cleanup');
            }
        }
    }

    /**
     * Check if the transport is running
     */
    isTransportRunning(): boolean {
        return this.isRunning && this.ipcServer !== null;
    }

    /**
     * Get the server instance
     */
    getServer(): IPCServer | null {
        return this.ipcServer;
    }

    /**
     * Restart the transport
     */
    async restartTransport(): Promise<IPCServer> {
        await this.stopTransport();
        return await this.startTransport();
    }

    /**
     * Get transport status
     */
    getTransportStatus(): {
        isRunning: boolean;
        hasServer: boolean;
        transportType: string;
        ipcPath: string;
        isWindows: boolean;
    } {
        return {
            isRunning: this.isRunning,
            hasServer: this.ipcServer !== null,
            transportType: 'ipc',
            ipcPath: this.configuration.getIPCPath(),
            isWindows: this.configuration.isWindows()
        };
    }

    /**
     * Get transport diagnostics
     */
    getDiagnostics(): {
        transportType: string;
        isRunning: boolean;
        hasServer: boolean;
        ipcPath: string;
        isWindows: boolean;
        socketExists?: boolean;
    } {
        type DiagnosticsWithSocket = {
            transportType: string;
            isRunning: boolean;
            hasServer: boolean;
            ipcPath: string;
            isWindows: boolean;
        } & { socketExists?: boolean };

        const diagnostics: DiagnosticsWithSocket = {
            transportType: 'ipc',
            isRunning: this.isRunning,
            hasServer: this.ipcServer !== null,
            ipcPath: this.configuration.getIPCPath(),
            isWindows: this.configuration.isWindows()
        };

        // Check if socket exists (for Unix systems)
        if (!this.configuration.isWindows()) {
            const fsPromises = this.getFsPromisesModule();
            void fsPromises.access(this.configuration.getIPCPath())
                .then(() => {
                    diagnostics.socketExists = true;
                })
                .catch(() => {
                    diagnostics.socketExists = false;
                });
        }

        return diagnostics;
    }

    /**
     * Force cleanup socket (for emergency cleanup)
     */
    async forceCleanupSocket(): Promise<void> {
        if (this.configuration.isWindows()) {
            return;
        }

        try {
            await this.getFsPromisesModule().unlink(this.configuration.getIPCPath());
            logger.systemLog('Socket force cleaned up successfully');
        } catch (error) {
            logger.systemError(this.toError(error, 'Failed to force-clean IPC socket'), 'Force Socket Cleanup');
        }
    }
}