/**
 * Type definitions for ToolManager agent.
 */

import type { CommonResult } from '../../types';
import type { ToolContext } from '../../types/mcp/AgentTypes';

export type { ToolContext } from '../../types/mcp/AgentTypes';

export interface ToolRequestItem {
  agent: string;
  tools?: string[];
}

export interface ToolCallParams {
  agent: string;
  tool: string;
  params: Record<string, unknown>;
  continueOnFailure?: boolean;
}

export interface CliArgumentSchema {
  name: string;
  flag: string;
  type: string;
  required: boolean;
  positional: boolean;
  description?: string;
}

export interface CliToolSchema {
  agent: string;
  tool: string;
  description: string;
  command: string;
  usage: string;
  arguments: CliArgumentSchema[];
  examples: string[];
}

export interface GetToolsParams {
  workspaceId?: string;
  sessionId?: string;
  memory?: string;
  goal?: string;
  constraints?: string;
  imageProvider?: ToolContext['imageProvider'];
  imageModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;

  /**
   * CLI selector string. Examples:
   * - "--help"
   * - "storage"
   * - "storage move"
   * - "storage move, content read"
   */
  tool?: string;
}

export interface GetToolsResult extends CommonResult {
  success: boolean;
  error?: string;
  data?: {
    tools: CliToolSchema[];
  };
}

export interface UseToolParams {
  workspaceId?: string;
  sessionId?: string;
  memory?: string;
  goal?: string;
  constraints?: string;
  imageProvider?: ToolContext['imageProvider'];
  imageModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;

  /**
   * CLI command string. Supports one or more commands separated by commas.
   * Required.
   */
  tool?: string;
  strategy?: 'serial' | 'parallel';
}

export interface NormalizedUseToolParams {
  context: ToolContext;
  strategy?: 'serial' | 'parallel';
  calls: ToolCallParams[];
}

export interface ToolCallResult {
  agent: string;
  tool: string;
  success: boolean;
  params?: Record<string, unknown>;
  error?: string;
  data?: unknown;
}

export interface ToolFailure {
  agent: string;
  tool: string;
  error?: string;
}

export interface UseToolResult extends CommonResult {
  success: boolean;
  error?: string;
  data?: unknown;
}

export function getTopLevelToolContextSchema(): Record<string, unknown> {
  return {
    workspaceId: {
      type: 'string',
      description: 'Workspace ID. Use "default" for the global workspace. Do not invent workspace IDs.'
    },
    sessionId: {
      type: 'string',
      description: 'Stable human-readable session name for this chat. Reuse the same value for every tool call in the conversation so traces and saved states attach to the current session; Nexus stores the internal UUID silently.'
    },
    memory: {
      type: 'string',
      description: 'Brief summary of the conversation so far.'
    },
    goal: {
      type: 'string',
      description: 'Brief statement of the current objective.'
    },
    constraints: {
      type: 'string',
      description: 'Optional rules or limits.'
    }
  };
}
