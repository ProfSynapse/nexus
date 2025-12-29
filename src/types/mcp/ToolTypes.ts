/**
 * Location: src/types/mcp/ToolTypes.ts
 * 
 * Type definitions for MCP tool-related interfaces and data structures.
 * Used throughout the MCP system for type safety and consistency.
 */

/**
 * MCP tool call request structure
 */
export interface MCPToolCallRequest {
    params: {
        name: string;
        arguments: Record<string, unknown>;
    };
    meta?: {
        requestId?: string;
        timestamp?: Date;
        source?: string;
    };
}

/**
 * MCP tool call response structure
 */
export interface MCPToolCallResponse {
    content: Array<{
        type: 'text' | 'resource';
        text?: string;
        resource?: any;
    }>;
    isError?: boolean;
    error?: {
        code: string;
        message: string;
        data?: any;
    };
}

/**
 * Tool descriptor for MCP tool registration
 */
export interface ToolDescriptor {
    /** Tool name in format 'agentName_modeName' */
    name: string;
    
    /** Tool description */
    description: string;
    
    /** Input parameter schema */
    inputSchema?: any;
    
    /** Output result schema */
    outputSchema?: any;
    
    /** Tool metadata */
    metadata?: ToolMetadata;
    
    /** Tool capabilities */
    capabilities?: ToolCapabilities;
}

/**
 * Tool metadata information
 */
export interface ToolMetadata {
    agent: string;
    mode: string;
    version?: string;
    category?: string;
    tags?: string[];
    deprecated?: boolean;
    experimental?: boolean;
}

/**
 * Tool capabilities definition
 */
export interface ToolCapabilities {
    requiresAuth?: boolean;
    requiresVectorStore?: boolean;
    requiresLLM?: boolean;
    supportsBatch?: boolean;
    supportsStreaming?: boolean;
    isIdempotent?: boolean;
}

/**
 * MCP connection status information
 */
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

/**
 * Tool routing statistics
 */
export interface ToolRoutingStats {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    averageExecutionTime: number;
    callsByAgent: Record<string, number>;
    callsByMode: Record<string, number>;
    errorsByType: Record<string, number>;
}

/**
 * Tool execution context
 */
export interface ToolExecutionContext {
    requestId?: string;
    sessionId?: string;
    userId?: string;
    timestamp: Date;
    source: 'mcp-client' | 'internal' | 'api';
    metadata?: Record<string, unknown>;
}