/**
 * IPCTransportManager - Handles IPC transport management
 * Follows Single Responsibility Principle by focusing only on IPC transport
 */

import { Server as NetServer, Socket, createServer } from 'net';
import { promises as fs } from 'fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { ServerConfiguration } from '../services/ServerConfiguration';
import { StdioTransportManager } from './StdioTransportManager';
import { logger } from '../../utils/logger';

/**
 * Service responsible for IPC transport management
 * Follows SRP by focusing only on IPC transport operations
 */
export class IPCTransportManager {
    private ipcServer: NetServer | null = null;
    private isRunning: boolean = false;

    constructor(
        private configuration: ServerConfiguration,
        private stdioTransportManager: StdioTransportManager
    ) {}

    /**
     * Start the IPC transport server
     */
    async startTransport(): Promise<NetServer> {
        if (this.ipcServer) {
            return this.ipcServer;
        }

        const isWindows = this.configuration.isWindows();
        const ipcPath = this.configuration.getIPCPath();

        if (!isWindows) {
            await this.cleanupSocket();
        }

        return new Promise((resolve, reject) => {
            try {
                const server = createServer((socket) => {
                    this.handleSocketConnection(socket);
                });

                this.setupServerErrorHandling(server, ipcPath, isWindows, reject);
                this.startListening(server, ipcPath, isWindows, resolve, reject);
            } catch (error) {
                logger.systemError(error as Error, 'IPC Server Creation');
                reject(error);
            }
        });
    }

    /**
     * Handle new socket connections
     *
     * Wires the raw socket's lifecycle events to the MCP transport so that
     * Protocol._transport is cleared when a client disconnects.  Without this,
     * a dropped connector permanently wedges the single-transport Protocol and
     * all subsequent connections are silently black-holed.
     */
    private handleSocketConnection(socket: NodeJS.ReadWriteStream): void {
        try {
            const transport = this.stdioTransportManager.createSocketTransport(socket, socket);

            // The underlying socket emits 'close'/'end' when the connector
            // process dies — forward that into transport.close() so the SDK's
            // Protocol._onclose() fires and resets _transport to undefined.
            const netSocket = socket as Socket;
            let closed = false;
            const onSocketGone = () => {
                if (closed) return;
                closed = true;
                logger.systemLog('IPC socket disconnected — releasing transport');
                transport.close().catch((err: Error) => {
                    logger.systemError(err, 'IPC Transport Close on Disconnect');
                });
            };
            netSocket.on('close', onSocketGone);
            netSocket.on('end', onSocketGone);

            this.stdioTransportManager.connectSocketTransport(transport)
                .then(() => {
                    logger.systemLog('IPC socket connected successfully');
                })
                .catch(error => {
                    logger.systemError(error as Error, 'IPC Socket Connection');
                    // server.connect() rejected (e.g. "Already connected to a
                    // transport") — destroy the raw socket so we don't leak FDs.
                    if (!netSocket.destroyed) netSocket.destroy();
                });
        } catch (error) {
            logger.systemError(error as Error, 'IPC Socket Handling');
            // Destroy on synchronous failure too
            const netSocket = socket as Socket;
            if (!netSocket.destroyed) netSocket.destroy();
        }
    }

    /**
     * Setup server error handling
     */
    private setupServerErrorHandling(
        server: NetServer,
        ipcPath: string,
        isWindows: boolean,
        reject: (error: Error) => void
    ): void {
        server.on('error', (error) => {
            logger.systemError(error as Error, 'IPC Server');
            
            if (!isWindows && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
                this.handleAddressInUse(server, ipcPath, reject);
            } else {
                reject(error);
            }
        });
    }

    /**
     * Handle address in use error
     */
    private handleAddressInUse(
        server: NetServer,
        ipcPath: string,
        reject: (error: Error) => void
    ): void {
        this.cleanupSocket()
            .then(() => {
                try {
                    server.listen(ipcPath);
                } catch (listenError) {
                    logger.systemError(listenError as Error, 'Server Listen Retry');
                    reject(listenError as Error);
                }
            })
            .catch(cleanupError => {
                logger.systemError(cleanupError as Error, 'Socket Cleanup');
                reject(cleanupError);
            });
    }

    /**
     * Start listening on the IPC path
     */
    private startListening(
        server: NetServer,
        ipcPath: string,
        isWindows: boolean,
        resolve: (server: NetServer) => void,
        reject: (error: Error) => void
    ): void {
        server.listen(ipcPath, () => {
            this.handleListeningStarted(server, ipcPath, isWindows, resolve, reject);
        });
    }

    /**
     * Handle successful listening start
     */
    private handleListeningStarted(
        server: NetServer,
        ipcPath: string,
        isWindows: boolean,
        resolve: (server: NetServer) => void,
        reject: (error: Error) => void
    ): void {
        if (!isWindows) {
            fs.chmod(ipcPath, 0o666).catch(error => {
                logger.systemError(error as Error, 'Socket Permissions');
            });
        }

        this.ipcServer = server;
        this.isRunning = true;
        
        logger.systemLog(`IPC server started on path: ${ipcPath}`);
        resolve(server);
    }

    /**
     * Stop the IPC transport server
     */
    async stopTransport(): Promise<void> {
        if (!this.ipcServer) {
            return;
        }

        try {
            this.ipcServer.close();
            this.ipcServer = null;
            this.isRunning = false;
            
            await this.cleanupSocket();
            
            logger.systemLog('IPC transport stopped successfully');
        } catch (error) {
            logger.systemError(error as Error, 'IPC Transport Stop');
            throw error;
        }
    }

    /**
     * Clean up the socket file
     */
    private async cleanupSocket(): Promise<void> {
        if (this.configuration.isWindows()) {
            return;
        }

        try {
            await fs.unlink(this.configuration.getIPCPath());
        } catch (error) {
            // Ignore if file doesn't exist
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.systemError(error as Error, 'Socket Cleanup');
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
    getServer(): NetServer | null {
        return this.ipcServer;
    }

    /**
     * Restart the transport
     */
    async restartTransport(): Promise<NetServer> {
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
            try {
                fs.access(this.configuration.getIPCPath())
                    .then(() => {
                        diagnostics.socketExists = true;
                    })
                    .catch(() => {
                        diagnostics.socketExists = false;
                    });
            } catch (error) {
                diagnostics.socketExists = false;
            }
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
            await fs.unlink(this.configuration.getIPCPath());
            logger.systemLog('Socket force cleaned up successfully');
        } catch (error) {
            logger.systemError(error as Error, 'Force Socket Cleanup');
        }
    }
}