/**
 * HttpTransportManager - Modern HTTP transport using StreamableHTTPServerTransport
 * Based on MCP SDK examples and supports the latest protocol
 */

import { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError, ErrorCode, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger';
import { randomUUID } from 'node:crypto';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { SERVER_LABELS } from '../../constants/branding';

/**
 * Modern HTTP transport manager using StreamableHTTP
 * Supports both JSON response mode and streaming
 */
export class HttpTransportManager {
    private httpServer: http.Server | null = null;
    private app: express.Application;
    private isRunning: boolean = false;
    private port: number;
    private host: string;
    private transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

    constructor(
        private server: MCPSDKServer, 
        port: number = 3000, 
        host: string = 'localhost'
    ) {
        this.port = port;
        this.host = host;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Setup Express middleware
     */
    private setupMiddleware(): void {
        // Enable CORS for cross-origin requests
        this.app.use(cors({
            origin: '*',
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));
        
        // Parse JSON bodies
        this.app.use(express.json());

        // Add request logging
        this.app.use((req, res, next) => {
            logger.systemLog(`[HTTP Transport] ${req.method} ${req.path} from ${req.ip}`);
            next();
        });
    }

    /**
     * Setup Express routes for MCP
     */
    private setupRoutes(): void {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                server: SERVER_LABELS.current,
                timestamp: new Date().toISOString()
            });
        });

        // Main MCP endpoint (supports both initialization and regular requests)
        this.app.post('/sse', async (req, res) => {
            try {
                await this.handleMCPRequest(req, res);
            } catch (error) {
                logger.systemError(error as Error, 'MCP Request Handler');
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32603,
                            message: 'Internal server error',
                        },
                        id: null,
                    });
                }
            }
        });

        // Alternative endpoint for compatibility
        this.app.post('/mcp', async (req, res) => {
            try {
                await this.handleMCPRequest(req, res);
            } catch (error) {
                logger.systemError(error as Error, 'MCP Request Handler');
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32603,
                            message: 'Internal server error',
                        },
                        id: null,
                    });
                }
            }
        });
    }

    /**
     * Handle MCP requests (both initialization and regular requests)
     */
    private async handleMCPRequest(req: express.Request, res: express.Response): Promise<void> {
        const sessionId = req.headers['x-session-id'] as string;
        
        let transport: StreamableHTTPServerTransport;
        
        if (sessionId && this.transports[sessionId]) {
            // Reuse existing transport
            transport = this.transports[sessionId];
            logger.systemLog(`[HTTP Transport] Reusing session: ${sessionId}`);
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request - create new transport
            logger.systemLog(`[HTTP Transport] Creating new session for initialization`);
            
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: true, // Enable JSON response mode for OpenAI MCP
                onsessioninitialized: (newSessionId: string) => {
                    logger.systemLog(`[HTTP Transport] Session initialized: ${newSessionId}`);
                    this.transports[newSessionId] = transport;
                }
            });
            
            // Connect the transport to the MCP server
            await this.server.connect(transport);
            
            // Handle the initialization request
            await transport.handleRequest(req, res, req.body);
            return;
        } else {
            // Invalid request - no session ID or not initialization request
            logger.systemWarn(`[HTTP Transport] Invalid request: sessionId=${sessionId}, isInit=${isInitializeRequest(req.body)}`);
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided or not initialization request',
                },
                id: null,
            });
            return;
        }
        
        // Handle regular request with existing transport
        await transport.handleRequest(req, res, req.body);
    }

    /**
     * Start the HTTP transport
     */
    async startTransport(): Promise<{ httpServer: http.Server; app: express.Application }> {
        if (this.httpServer) {
            return { httpServer: this.httpServer, app: this.app };
        }
        try {
            // Create HTTP server with Express app
            this.httpServer = http.createServer(this.app);
            
            // Start HTTP server
            await new Promise<void>((resolve, reject) => {
                this.httpServer!.listen(this.port, this.host, () => {
                    this.isRunning = true;
                    logger.systemLog(`HTTP MCP server started on ${this.host}:${this.port}`);
                    logger.systemLog(`MCP endpoint available at: http://${this.host}:${this.port}/sse`);
                    resolve();
                });
                
                this.httpServer!.on('error', (error: NodeJS.ErrnoException) => {
                    if (error.code === 'EADDRINUSE') {
                        logger.systemError(error, `Port ${this.port} is already in use`);
                    } else {
                        logger.systemError(error, 'HTTP Server Start');
                    }
                    reject(error);
                });
            });

            logger.systemLog('HTTP transport started successfully');
            
            return { httpServer: this.httpServer, app: this.app };
        } catch (error) {
            logger.systemError(error as Error, 'HTTP Transport Start');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to start HTTP transport',
                error
            );
        }
    }

    /**
     * Stop the HTTP transport
     */
    async stopTransport(): Promise<void> {
        if (!this.httpServer) {
            return; // Nothing to stop
        }

        try {
            // Close all active transports
            for (const sessionId in this.transports) {
                try {
                    logger.systemLog(`Closing transport for session ${sessionId}`);
                    await this.transports[sessionId].close();
                    delete this.transports[sessionId];
                } catch (error) {
                    logger.systemError(error as Error, `Error closing transport for session ${sessionId}`);
                }
            }

            // Close HTTP server
            await new Promise<void>((resolve, reject) => {
                this.httpServer!.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        this.httpServer = null;
                        this.isRunning = false;
                        logger.systemLog('HTTP transport stopped successfully');
                        resolve();
                    }
                });
            });
        } catch (error) {
            logger.systemError(error as Error, 'HTTP Transport Stop');
            throw new McpError(
                ErrorCode.InternalError,
                'Failed to stop HTTP transport',
                error
            );
        }
    }

    /**
     * Get transport status
     */
    getTransportStatus(): {
        isRunning: boolean;
        endpoint?: string;
        port: number;
        host: string;
        activeSessions: number;
        sessions: string[];
    } {
        return {
            isRunning: this.isRunning,
            endpoint: this.isRunning ? `http://${this.host}:${this.port}/sse` : undefined,
            port: this.port,
            host: this.host,
            activeSessions: Object.keys(this.transports).length,
            sessions: Object.keys(this.transports)
        };
    }

    /**
     * Check if transport is running
     */
    isTransportRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Get the server endpoint URL
     */
    getServerUrl(): string {
        if (!this.isRunning) {
            throw new McpError(
                ErrorCode.InternalError,
                'Cannot get server URL: transport not running'
            );
        }
        return `http://${this.host}:${this.port}/sse`;
    }

    /**
     * Update port configuration (only when stopped)
     */
    setPort(port: number): void {
        if (this.isRunning) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'Cannot change port while transport is running'
            );
        }
        this.port = port;
    }

    /**
     * Update host configuration (only when stopped)
     */
    setHost(host: string): void {
        if (this.isRunning) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'Cannot change host while transport is running'
            );
        }
        this.host = host;
    }

    /**
     * Get active session count
     */
    getActiveSessionCount(): number {
        return Object.keys(this.transports).length;
    }

    /**
     * Clean up a specific session
     */
    async cleanupSession(sessionId: string): Promise<void> {
        const transport = this.transports[sessionId];
        if (transport) {
            try {
                await transport.close();
                delete this.transports[sessionId];
                logger.systemLog(`Cleaned up session: ${sessionId}`);
            } catch (error) {
                logger.systemError(error as Error, `Error cleaning up session ${sessionId}`);
            }
        }
    }
}
