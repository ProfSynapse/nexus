/**
 * IPCTransportManager - Handles IPC transport management
 * Follows Single Responsibility Principle by focusing only on IPC transport
 */

import { desktopRequire } from '../../utils/desktopRequire';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { ServerConfiguration } from '../services/ServerConfiguration';
import { StdioTransportManager } from './StdioTransportManager';
import { logger } from '../../utils/logger';

type NetServer = ReturnType<typeof import('net')['createServer']>;
type Socket = import('net').Socket;

/**
 * Identity of the socket file this instance created, captured at listen().
 *
 * dev+ino identify the file itself rather than its name, which is the whole
 * point: the IPC path is derived from the vault name, so it is shared by every
 * instance and cannot tell us whether the file there is still ours.
 */
interface OwnedSocket {
    path: string;
    dev: number;
    ino: number;
}

/**
 * How long teardown waits on a single client before giving up on it. A client
 * that has not disconnected cleanly can leave close() pending indefinitely,
 * which would stall restartServer().
 */
const TEARDOWN_TIMEOUT_MS = 3000;

/** How long to wait for a connect() probe before calling a socket dead. */
const LIVENESS_PROBE_TIMEOUT_MS = 250;

/**
 * Service responsible for IPC transport management
 * Follows SRP by focusing only on IPC transport operations
 */
export class IPCTransportManager {
    private ipcServer: NetServer | null = null;
    private isRunning = false;
    /** Per-connection MCPSDKServer instances for multi-client support. */
    private activeConnections: Set<MCPSDKServer> = new Set();
    /** Track current transport for proactive cleanup */
    private currentTransport: StdioServerTransport | null = null;
    /** The socket file we created, so teardown never deletes someone else's. */
    private ownedSocket: OwnedSocket | null = null;

    constructor(
        private configuration: ServerConfiguration,
        private stdioTransportManager: StdioTransportManager,
        private serverFactory?: () => MCPSDKServer
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
                const net = desktopRequire<typeof import('net')>('net');
                const server = net.createServer((socket) => {
                    this.handleSocketConnection(socket).catch(error => {
                        logger.systemError(error as Error, 'IPC Socket Handling');
                        const netSocket = socket;
                        if (!netSocket.destroyed) netSocket.destroy();
                    });
                });

                this.setupServerErrorHandling(server, ipcPath, isWindows, reject);
                this.startListening(server, ipcPath, isWindows, resolve, reject);
            } catch (error) {
                logger.systemError(error as Error, 'IPC Server Creation');
                reject(error instanceof Error ? error : new Error(String(error)));
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
    private async handleSocketConnection(socket: Socket): Promise<void> {
        if (this.serverFactory) {
            this.handleMultiClientConnection(socket);
        } else {
            await this.handleSingleClientConnection(socket);
        }
    }

    /**
     * Per-connection server path: create a dedicated MCPSDKServer for this
     * socket so that multiple clients can coexist.
     */
    private handleMultiClientConnection(socket: Socket): void {
        try {
            const serverFactory = this.serverFactory;
            if (!serverFactory) {
                throw new Error('IPC multi-client server factory is not configured');
            }

            const server = serverFactory();
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
                    logger.systemError(error as Error, 'IPC Socket Connection');
                    if (!netSocket.destroyed) netSocket.destroy();
                });
        } catch (error) {
            logger.systemError(error as Error, 'IPC Socket Handling');
            if (!socket.destroyed) socket.destroy();
        }
    }

    /**
     * Single-server path via StdioTransportManager (kept as fallback).
     * Wires the raw socket's lifecycle events to the MCP transport
     * so that Protocol._transport is cleared when a client disconnects.
     */
    private async handleSingleClientConnection(socket: Socket): Promise<void> {
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
                        new Promise(resolve => window.setTimeout(resolve, 500))
                    ]);
                } catch (err) {
                    logger.systemError(err as Error, 'Proactive Transport Cleanup');
                }
                this.currentTransport = null;
            }

            await this.stdioTransportManager.connectSocketTransport(transport);
            this.currentTransport = transport;
            logger.systemLog('IPC socket connected successfully');
        } catch (error) {
            logger.systemError(error as Error, 'IPC Socket Connection');
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
            logger.systemError(error, 'IPC Server');
            
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
                    // Retry after clearing a stale socket — same owner-only creation.
                    this.listenSecure(server, ipcPath);
                } catch (listenError) {
                    logger.systemError(listenError as Error, 'Server Listen Retry');
                    reject(listenError instanceof Error ? listenError : new Error(String(listenError)));
                }
            })
            .catch(cleanupError => {
                logger.systemError(cleanupError as Error, 'Socket Cleanup');
                reject(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
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
        this.listenSecure(server, ipcPath, () => {
            this.handleListeningStarted(server, ipcPath, isWindows, resolve, reject);
        });
    }

    /**
     * Bind the unix-domain socket owner-only. The socket file is created during
     * listen(), BEFORE the 'listening' callback runs — so tightening it only in
     * the callback (or via an async chmod) leaves a window where another local
     * user could connect to the unauthenticated tool server. We set a restrictive
     * umask (0o177 → mode 0o600) around the synchronous listen() so the socket is
     * never observable with wider permissions, then restore the prior umask.
     * No-op tightening on Windows (named pipes; POSIX modes don't apply).
     */
    private listenSecure(server: NetServer, ipcPath: string, onListening?: () => void): void {
        const isWindows = this.configuration.isWindows();
        let priorUmask: number | undefined;
        if (!isWindows && typeof process.umask === 'function') {
            try { priorUmask = process.umask(0o177); } catch { priorUmask = undefined; }
        }
        try {
            if (onListening) server.listen(ipcPath, onListening);
            else server.listen(ipcPath);
        } finally {
            if (priorUmask !== undefined) {
                try { process.umask(priorUmask); } catch { /* restore best-effort */ }
            }
        }
    }

    /**
     * Handle successful listening start
     */
    private handleListeningStarted(
        server: NetServer,
        ipcPath: string,
        isWindows: boolean,
        resolve: (server: NetServer) => void,
        _reject: (error: Error) => void
    ): void {
        if (!isWindows) {
            // Backstop only — the socket is already born 0o600 via the umask in
            // listenSecure(). chmod SYNCHRONOUSLY (not async) so there is no
            // event-loop turn during which a wider mode could be observed.
            try {
                desktopRequire<typeof import('fs')>('fs').chmodSync(ipcPath, 0o600);
            } catch (error) {
                logger.systemError(error as Error, 'Socket Permissions');
            }

            // Record which file we created so teardown can tell it apart from a
            // successor's socket at the same path. See releaseOwnedSocket().
            this.ownedSocket = this.readSocketIdentity(ipcPath);
            if (!this.ownedSocket) {
                logger.systemLog(`Could not identify the socket at ${ipcPath}; teardown will leave it in place`);
            }
        }

        this.ipcServer = server;
        this.isRunning = true;
        
        logger.systemLog(`IPC server started on path: ${ipcPath}`);
        resolve(server);
    }

    /**
     * Stop the IPC transport server and close all active connections.
     *
     * Order matters here, and it is the whole of issue #337. `server.close()`
     * unlinks the bound socket file **synchronously, at call time** — not when
     * the last connection drains — and it unlinks the path it was given rather
     * than the file it created. Because the IPC path is derived from the vault
     * name, every instance shares it, so a `close()` deferred behind connection
     * teardown deletes whichever socket happens to be at that path by then.
     *
     * On a hot reload that is the *successor's* socket: the new instance binds
     * within a second or two, the old instance finishes tearing down twenty-odd
     * seconds later, and its close() takes the new socket file with it. The new
     * server keeps its listening fd, so nothing errors and nothing is logged —
     * the transport simply becomes unreachable.
     *
     * So the listening server is closed first, before any await — and callers
     * that are about to do something slow should call closeListener() earlier
     * still.
     */
    async stopTransport(): Promise<void> {
        const hasWork = this.ipcServer !== null
            || this.ownedSocket !== null
            || this.currentTransport !== null
            || this.activeConnections.size > 0;
        if (!hasWork) {
            return;
        }

        this.closeListener();

        try {
            await this.closeActiveConnections();
            await this.releaseOwnedSocket();

            logger.systemLog('IPC transport stopped successfully');
        } catch (error) {
            logger.systemError(error as Error, 'IPC Transport Stop');
            throw error;
        }
    }

    /**
     * Stop accepting connections and release the socket file — synchronously,
     * so it can be done in a turn that is not allowed to await.
     *
     * Unloading the plugin runs embedding shutdown, a state save and a SQLite
     * close before it reaches stopTransport(), which is tens of seconds during
     * which the replacement instance has already bound our path. Whoever knows
     * a slow shutdown is coming should call this first; stopTransport() then
     * finishes the teardown whenever it gets there.
     *
     * Idempotent.
     */
    closeListener(): void {
        const server = this.ipcServer;
        if (!server) {
            return;
        }

        this.ipcServer = null;
        this.isRunning = false;
        server.close();
        logger.systemLog('IPC listener closed; socket path released');
    }

    /**
     * Close every per-connection server and any single-client transport.
     *
     * Bounded: the socket file is already released by the time this runs, so a
     * client that never disconnects can only cost us a leaked object, and
     * waiting on it would stall restartServer() for as long as it stays wedged.
     */
    private async closeActiveConnections(): Promise<void> {
        const closePromises = Array.from(this.activeConnections).map(server =>
            server.close().catch((err: Error) => {
                logger.systemError(err, 'Per-Connection Server Close on Stop');
            })
        );
        this.activeConnections.clear();
        await this.withTeardownTimeout(Promise.all(closePromises), 'Per-connection server close');

        if (this.currentTransport) {
            const transport = this.currentTransport;
            this.currentTransport = null;
            await this.withTeardownTimeout(
                transport.close().catch((err: Error) => {
                    logger.systemError(err, 'Transport Cleanup on Stop');
                }),
                'Transport close'
            );
        }
    }

    /**
     * Give up on teardown work that has not settled, rather than blocking stop.
     */
    private async withTeardownTimeout(work: Promise<unknown>, label: string): Promise<void> {
        let timer: number | undefined;
        const expiry = new Promise<void>(resolve => {
            timer = window.setTimeout(() => {
                logger.systemLog(`${label} did not settle within ${TEARDOWN_TIMEOUT_MS}ms — continuing teardown`);
                resolve();
            }, TEARDOWN_TIMEOUT_MS);
        });

        try {
            await Promise.race([work.then(() => undefined), expiry]);
        } finally {
            if (timer !== undefined) {
                window.clearTimeout(timer);
            }
        }
    }

    /**
     * Remove the socket file, but only while it is still the one we created.
     *
     * `server.close()` has normally unlinked it already; this is the backstop
     * for the paths where it has not. It must be identity-checked for the same
     * reason close() has to happen early — deleting by path alone, on a path
     * every instance shares, is how a successor's socket gets taken out.
     */
    private async releaseOwnedSocket(): Promise<void> {
        const owned = this.ownedSocket;
        this.ownedSocket = null;

        if (this.configuration.isWindows() || !owned) {
            return;
        }

        const current = this.readSocketIdentity(owned.path);
        if (!current) {
            return;
        }

        if (current.dev !== owned.dev || current.ino !== owned.ino) {
            logger.systemLog(`Leaving the socket at ${owned.path} alone — it belongs to another instance now`);
            return;
        }

        try {
            // A successor could still rebind between the stat above and this
            // unlink. There is no unlink-by-inode on POSIX, so the window
            // cannot be closed entirely — only reduced from tens of seconds to
            // a single turn, which is what the identity check buys.
            const fs = desktopRequire<typeof import('fs')>('fs').promises;
            await fs.unlink(owned.path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.systemError(error as Error, 'Socket Cleanup');
            }
        }
    }

    /**
     * Stat the socket file for its identity, or null if it is not there.
     */
    private readSocketIdentity(ipcPath: string): OwnedSocket | null {
        try {
            const stats = desktopRequire<typeof import('fs')>('fs').statSync(ipcPath);
            return { path: ipcPath, dev: stats.dev, ino: stats.ino };
        } catch {
            return null;
        }
    }

    /**
     * Clear whatever socket file is sitting at our path before we bind.
     *
     * Deleting by path is right *here* — the job is to clear a socket a crashed
     * process left behind, and a stale file has no identity worth preserving.
     * It is wrong in stopTransport(); see releaseOwnedSocket().
     *
     * We take over a live socket too, because within a vault this path is ours,
     * but we say so first. Two vaults sharing a name would land here, and the
     * silence is what made #337 cost a day.
     */
    private async cleanupSocket(): Promise<void> {
        if (this.configuration.isWindows()) {
            return;
        }

        const ipcPath = this.configuration.getIPCPath();
        if (await this.isSocketLive(ipcPath)) {
            logger.systemLog(`Taking over a live IPC socket at ${ipcPath} — another instance will lose its transport`);
        }

        try {
            const fs = desktopRequire<typeof import('fs')>('fs').promises;
            await fs.unlink(ipcPath);
        } catch (error) {
            // Ignore if file doesn't exist
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.systemError(error as Error, 'Socket Cleanup');
            }
        }
    }

    /**
     * Is something still accepting connections on this path? A refused connect
     * means the file is stale. A probe that neither connects nor refuses in
     * time counts as dead, so an unresponsive socket cannot block startup.
     */
    private isSocketLive(ipcPath: string): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            let probe: Socket;
            try {
                probe = desktopRequire<typeof import('net')>('net').connect(ipcPath);
            } catch {
                resolve(false);
                return;
            }

            let timer: number | undefined;
            const settle = (alive: boolean) => {
                if (timer !== undefined) {
                    window.clearTimeout(timer);
                    timer = undefined;
                }
                probe.removeAllListeners();
                probe.destroy();
                resolve(alive);
            };

            timer = window.setTimeout(() => settle(false), LIVENESS_PROBE_TIMEOUT_MS);
            probe.once('connect', () => settle(true));
            probe.once('error', () => settle(false));
        });
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
                const fs = desktopRequire<typeof import('fs')>('fs').promises;
                fs.access(this.configuration.getIPCPath())
                    .then(() => {
                        diagnostics.socketExists = true;
                    })
                    .catch(() => {
                        diagnostics.socketExists = false;
                    });
            } catch {
                diagnostics.socketExists = false;
            }
        }

        return diagnostics;
    }

    /**
     * Force cleanup socket (for emergency cleanup).
     *
     * By path and unconditional, on purpose — this is the escape hatch for when
     * the identity-checked path in releaseOwnedSocket() has decided to leave a
     * file alone and a human disagrees.
     */
    async forceCleanupSocket(): Promise<void> {
        if (this.configuration.isWindows()) {
            return;
        }

        this.ownedSocket = null;

        try {
            const fs = desktopRequire<typeof import('fs')>('fs').promises;
            await fs.unlink(this.configuration.getIPCPath());
            logger.systemLog('Socket force cleaned up successfully');
        } catch (error) {
            logger.systemError(error as Error, 'Force Socket Cleanup');
        }
    }
}
