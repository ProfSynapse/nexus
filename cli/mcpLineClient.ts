/**
 * mcpLineClient — minimal MCP-over-socket client for the Nexus local CLI.
 *
 * This is the ONLY genuinely new protocol code in the CLI bridge: it speaks the
 * client side of MCP (initialize + notifications/initialized + tools/call) over the
 * same unix-domain socket that connector.js pipes to. Framing is newline-delimited
 * JSON-RPC (what the SDK's StdioServerTransport expects).
 *
 * Spike scope: dependency-free (node builtins only) so it compiles/runs standalone.
 * Productionizing (per docs/plans/local-cli-agent-bridge-plan.md) extracts the socket
 * path logic to src/utils/ipcSocketPath.ts and shares it with connector.ts.
 */
import { createConnection, Socket } from 'node:net';

interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}

export interface McpToolResult {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [k: string]: unknown;
}

interface JsonRpcResponse {
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse only the JSON-RPC response shape consumed by this client. */
export function parseJsonRpcResponse(line: string): JsonRpcResponse | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line) as unknown;
    } catch {
        return null;
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'number') return null;

    const response: JsonRpcResponse = { id: parsed.id };
    if ('result' in parsed) response.result = parsed.result;
    if ('error' in parsed) {
        if (!isRecord(parsed.error)
            || typeof parsed.error.code !== 'number'
            || typeof parsed.error.message !== 'string') return null;
        response.error = { code: parsed.error.code, message: parsed.error.message };
    }
    return response;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
/** Ten minutes: long enough for an image edit or a slow generation model. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 600_000;

/**
 * Read a positive integer millisecond override from the environment; anything
 * else (unset, empty, NaN, zero, negative) yields undefined so the default holds.
 */
export function parseTimeoutEnv(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export class McpLineClient {
    private socket: Socket | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private buffer = '';
    private readonly timeoutMs: number;
    private readonly toolCallTimeoutMs: number;

    /**
     * `timeoutMs` bounds the handshake and discovery calls, which answer from
     * memory. `toolCallTimeoutMs` bounds `tools/call`, which may be waiting on a
     * provider: an image edit or a slow model can take well over a minute, and
     * a 20-second client timeout used to abandon a call the plugin then finished
     * anyway (the image landed in the vault after the CLI had already errored).
     */
    constructor(
        private readonly socketPath: string,
        opts: { timeoutMs?: number; toolCallTimeoutMs?: number } = {}
    ) {
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.toolCallTimeoutMs = opts.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = createConnection(this.socketPath);
            this.socket = socket;
            const onConnectError = (err: Error) => {
                reject(new Error(
                    `Cannot connect to ${this.socketPath}: ${err.message}. ` +
                    `Is Obsidian open with Nexus running for this vault?`
                ));
            };
            socket.once('error', onConnectError);
            socket.once('connect', () => {
                socket.removeListener('error', onConnectError);
                socket.on('error', (err) => this.failAll(err));
                resolve();
            });
            socket.on('data', (chunk) => this.onData(chunk));
            socket.on('close', () => this.failAll(new Error('socket closed by server')));
        });
    }

    private onData(chunk: Buffer): void {
        this.buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            const msg = parseJsonRpcResponse(line);
            if (!msg) continue; // ignore non-JSON, notifications, and malformed responses
            if (this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id)!;
                this.pending.delete(msg.id);
                if (msg.error) {
                    p.reject(new Error(`${msg.error.message} (JSON-RPC code ${msg.error.code})`));
                } else {
                    p.resolve(msg.result);
                }
            }
            // server-initiated requests / notifications: ignored for the spike
        }
    }

    private failAll(err: Error): void {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
    }

    private request(method: string, params?: unknown, timeoutMs: number = this.timeoutMs): Promise<unknown> {
        if (!this.socket) return Promise.reject(new Error('not connected'));
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timeout after ${timeoutMs}ms waiting for "${method}"`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            this.socket!.write(payload);
        });
    }

    private notify(method: string, params?: unknown): void {
        this.socket?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    async initialize(): Promise<unknown> {
        const result = await this.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'nexus-cli', version: '0.1.0' },
        });
        this.notify('notifications/initialized');
        return result;
    }

    listTools(): Promise<unknown> {
        return this.request('tools/list', {});
    }

    callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
        return this.request('tools/call', { name, arguments: args }, this.toolCallTimeoutMs) as Promise<McpToolResult>;
    }

    close(): void {
        this.socket?.end();
        this.socket?.destroy();
        this.socket = null;
    }
}
