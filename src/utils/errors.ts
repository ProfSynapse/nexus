/**
 * Mobile-safe error utilities
 *
 * These provide similar functionality to MCP SDK errors but without
 * pulling in Node.js dependencies. On desktop, the actual MCP SDK
 * errors are used; on mobile, these lightweight equivalents are used.
 */

/**
 * Error codes matching MCP SDK ErrorCode enum
 */
export enum NexusErrorCode {
    InternalError = -32603,
    InvalidParams = -32602,
    MethodNotFound = -32601,
    ParseError = -32700,
    InvalidRequest = -32600,
}

/**
 * Lightweight error class that mimics McpError structure
 */
export class NexusError extends Error {
    public readonly code: number;
    public readonly data?: unknown;

    constructor(code: NexusErrorCode, message: string, data?: unknown) {
        super(message);
        this.name = 'NexusError';
        this.code = code;
        this.data = data;
    }
}
