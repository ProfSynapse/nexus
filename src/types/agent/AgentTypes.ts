/**
 * Location: src/types/agent/AgentTypes.ts
 *
 * Type definitions for agent-related interfaces and data structures.
 * Used throughout the agent system for type safety and consistency.
 */

/**
 * Interface for agent tool call parameters
 */
export interface AgentToolParams {
    agent: string;
    tool: string;
    params: Record<string, unknown>;
}

/**
 * @deprecated Use AgentToolParams instead
 */
export type AgentModeParams = AgentToolParams;

/**
 * Agent registration status information
 */
export interface AgentRegistrationStatus {
    /** Total number of registered agents */
    totalAgents: number;
    
    /** Number of successfully initialized agents */
    initializedAgents: number;
    
    /** Number of failed agent initializations */
    failedAgents: number;
    
    /** Agent initialization errors */
    initializationErrors: Record<string, Error>;
    
    /** Registration timestamp */
    registrationTime: Date;
    
    /** Time taken for registration in milliseconds */
    registrationDuration: number;
}

/**
 * Workspace context information for tool calls
 */
export interface WorkspaceContext {
    workspaceId: string;
    workspacePath?: string[];
    activeWorkspace?: boolean;
}

/**
 * Tool call request information for capture
 */
export interface ToolCallRequest {
    toolCallId: string;
    agent: string;
    mode: string;
    params: Record<string, unknown>;
    timestamp: number;
    source: 'mcp-client' | 'internal' | 'api';
    workspaceContext?: WorkspaceContext | null;
}

/**
 * Tool call response information for capture
 */
export interface ToolCallResponse {
    result: any;
    success: boolean;
    executionTime: number;
    timestamp: number;
    resultType?: string;
    resultSummary?: string;
    affectedResources?: string[];
    error?: {
        type: string;
        message: string;
        code?: string;
        stack?: string;
    };
}

/**
 * Agent factory function type
 */
export type AgentFactory = () => Promise<any> | any;

/**
 * Agent constructor type
 */
export type AgentConstructor = new (...args: any[]) => any;

/**
 * Agent configuration options
 */
export interface AgentConfig {
    enabled?: boolean;
    modes?: string[];
    settings?: Record<string, unknown>;
    dependencies?: string[];
}

/**
 * Validation result structure
 */
export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings?: string[];
}