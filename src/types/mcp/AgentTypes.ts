/**
 * MCP Agent and Tool-related Types
 * Extracted from types.ts for better organization
 */

import { WorkspaceContext } from '../../utils/contextUtils';

/**
 * Tool call definition for chaining to another agent/tool
 */
export interface ToolCall {
  /**
   * Agent name to execute tool on
   */
  agent: string;

  /**
   * Tool to execute
   */
  tool: string;

  /**
   * Parameters to pass to the tool
   */
  parameters: any;

  /**
   * Whether to return results to original agent
   */
  returnHere?: boolean;

  /**
   * Whether this tool should be executed regardless of previous tool failures
   * Default is false - execution stops on first failure
   */
  continueOnFailure?: boolean;

  /**
   * Tool execution strategy
   * - serial: wait for previous tools to complete before executing (default)
   * - parallel: execute in parallel with other tools marked as parallel
   */
  strategy?: 'serial' | 'parallel';

  /**
   * Optional name to identify this tool call in the results
   */
  callName?: string;
}

/**
 * @deprecated Use ToolCall instead
 */
export type ModeCall = ToolCall;

/**
 * Common parameters structure for standardized agent tools
 * Provides session tracking and workspace context
 */
export interface CommonParameters {
  /**
   * Rich contextual information for this tool call including session management
   */
  context: {
    sessionId: string;
    workspaceId?: string;
    sessionDescription: string;
    sessionMemory: string;
    toolContext: string;
    primaryGoal: string;
    subgoal: string;
  };
  
  /**
   * Optional workspace context for scoping operations
   * Can be either an object with workspaceId or a JSON string representation
   */
  workspaceContext?: WorkspaceContext | string;
  
}

/**
 * Common result structure for standardized agent responses
 */
export interface CommonResult {
  /**
   * Whether the operation succeeded
   */
  success: boolean;
  
  /**
   * Error message if success is false
   */
  error?: string;
  
  /**
   * Operation-specific result data
   */
  data?: any;
  
  /**
   * Contextual information for this tool call including session management
   * Results can contain string context for backward compatibility
   */
  context?: {
    sessionId: string;
    workspaceId?: string;
    sessionDescription: string;
    sessionMemory: string;
    toolContext: string;
    primaryGoal: string;
    subgoal: string;
  } | string;
  
  /**
   * Workspace context that was used (for continuity)
   */
  workspaceContext?: WorkspaceContext;
  
}

/**
 * Tool call result for tracking execution outcomes
 */
export interface ToolCallResult extends CommonResult {
  /**
   * Agent name that executed the tool
   */
  agent?: string;

  /**
   * Tool that was executed
   */
  tool?: string;

  /**
   * Name of the tool call if specified
   */
  callName?: string;

  /**
   * Sequence number of this tool call
   */
  sequence?: number;

  /**
   * Timestamp when the tool call started
   */
  startTime?: number;

  /**
   * Timestamp when the tool call completed
   */
  endTime?: number;

  /**
   * Duration of the tool call in milliseconds
   */
  duration?: number;
}

/**
 * @deprecated Use ToolCallResult instead
 */
export type ModeCallResult = ToolCallResult;