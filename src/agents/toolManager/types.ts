/**
 * Type definitions for ToolManager agent
 * Follows existing CommonParameters/CommonResult patterns
 */

import type { CommonResult } from '../../types';
import type { ToolContext } from '../../types/mcp/AgentTypes';

// Re-export ToolContext from central location
export type { ToolContext } from '../../types/mcp/AgentTypes';

// ==================== GetTools Types ====================

/**
 * Request format for getTools
 * Maps agent names to arrays of tool names (or null/empty for all tools)
 *
 * Example:
 * {
 *   "vaultManager": ["listDirectory", "createFolder"],
 *   "contentManager": null  // gets all tools from contentManager
 * }
 */
export type ToolRequest = Record<string, string[] | null>;

/**
 * GetTools parameters - requires context for session tracking
 */
export interface GetToolsParams {
  /** Context for this request (required for session tracking) */
  context: ToolContext;

  /**
   * Map of agent names to tool names
   * - Array of tool names: get specific tools from that agent
   *
   * Example: { "vaultManager": ["listDirectory"], "contentManager": ["readContent"] }
   */
  request: ToolRequest;
}

/**
 * Shared JSON schema for ToolContext
 * Used by both getTools and useTool parameter schemas
 */
export function getToolContextSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'Workspace ID. Use "default" for global workspace, or use memoryManager_listWorkspaces to see available workspaces. Do NOT make up workspace IDs.'
      },
      sessionId: {
        type: 'string',
        description: 'Session identifier - provide any name, a standard ID will be assigned and returned. Use the assigned ID for subsequent calls.'
      },
      memory: { type: 'string', description: 'Essence of conversation so far (1-3 sentences)' },
      goal: { type: 'string', description: 'Current objective (1-3 sentences)' },
      constraints: { type: 'string', description: 'Rules/limits to follow (optional, 1-3 sentences)' }
    },
    required: ['workspaceId', 'sessionId', 'memory', 'goal'],
    description: 'Context for session tracking. Fill this FIRST before other parameters.'
  };
}

/**
 * Tool schema returned by getTools
 * Organized by agent for clarity
 */
export interface ToolSchema {
  /** Agent that owns this tool */
  agent: string;

  /** Tool name (without agent prefix) */
  tool: string;

  /** Tool description */
  description: string;

  /** Parameter schema WITHOUT common parameters (context stripped) */
  inputSchema: Record<string, unknown>;
}

/**
 * GetTools result - organized by agent
 */
export interface GetToolsResult extends CommonResult {
  success: boolean;
  error?: string;
  data?: {
    tools: ToolSchema[];
  };
}

// ==================== UseTool Types ====================

/**
 * Individual tool call within useTool
 */
export interface ToolCallParams {
  /** Agent name (e.g., "vaultManager") */
  agent: string;

  /** Tool name (e.g., "listDirectory") */
  tool: string;

  /** Tool-specific parameters (context injected automatically) */
  params: Record<string, unknown>;

  /** If true, continue executing remaining calls even if this one fails */
  continueOnFailure?: boolean;
}

/**
 * UseToolParams uses the new ToolContext schema (memory/goal/constraints)
 */
export interface UseToolParams {
  /** Context shared by all tool calls */
  context: ToolContext;

  /**
   * Execution strategy (default: 'serial')
   * - serial: Execute one at a time, stop on first error (unless continueOnFailure)
   * - parallel: Execute all concurrently
   */
  strategy?: 'serial' | 'parallel';

  /** Tool calls to execute */
  calls: ToolCallParams[];
}

/**
 * Result for a single tool call
 */
export interface ToolCallResult {
  /** Agent that executed the tool */
  agent: string;

  /** Tool that was executed */
  tool: string;

  /** Whether this call succeeded */
  success: boolean;

  /** Error message if this call failed */
  error?: string;

  /** Result data - only for tools that return data (readContent, searches) */
  data?: unknown;
}

/**
 * UseTool result
 */
export interface UseToolResult extends CommonResult {
  success: boolean;
  error?: string;
  data?: {
    results: ToolCallResult[];
  };
}
