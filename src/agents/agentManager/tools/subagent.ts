/**
 * SubagentTool - Spawn an autonomous subagent to work on a task
 *
 * The subagent runs independently in a branch, using tools as needed,
 * until it completes the task (responds without tool calls).
 *
 * Cancellation is handled via UI (AgentStatusModal, BranchHeader buttons).
 *
 * This tool is INTERNAL ONLY - hidden from MCP/Claude Desktop clients.
 */

import { BaseTool } from '../../baseTool';
import { getCommonResultSchema, createResult } from '../../../utils/schemaUtils';
import { CommonParameters, CommonResult } from '../../../types';
import type { SubagentExecutor } from '../../../services/chat/SubagentExecutor';

export interface SubagentToolParams extends CommonParameters {
  /** Clear description of what the subagent should accomplish */
  task: string;
  /** Optional custom agent/persona name to use */
  agent?: string;
  /** Pre-fetched tools: { agentName: [toolSlug1, toolSlug2] } */
  tools?: Record<string, string[]>;
  /** File paths to read - content will be included in the subagent's context */
  contextFiles?: string[];
  /** Maximum iterations before pausing (default: 10) */
  maxIterations?: number;
  /** Branch ID to continue from max_iterations state */
  continueBranchId?: string;
}

export interface SubagentToolResult extends CommonResult {
  data: {
    subagentId: string;
    branchId: string;
    status: 'started' | 'continued';
    message: string;
  } | null;
}

/**
 * Context provided by the execution environment
 * Contains ALL settings that should be inherited by the subagent
 */
export interface SubagentToolContext {
  conversationId: string;
  messageId: string;
  workspaceId?: string;
  sessionId?: string;
  source?: 'internal' | 'mcp';
  isSubagentBranch?: boolean;
  // Inherited model settings
  provider?: string;
  model?: string;
  // Inherited agent settings
  agentPrompt?: string;  // Custom agent's full system prompt
  agentName?: string;    // Custom agent name for reference
  // Inherited workspace settings
  workspaceData?: any;   // Full comprehensive workspace data (sessions, states, files, etc.)
  // Inherited context notes (file paths - subagent will read content)
  contextNotes?: string[];
  // Inherited thinking settings
  thinkingEnabled?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
}

export class SubagentTool extends BaseTool<SubagentToolParams, SubagentToolResult> {
  private subagentExecutor: SubagentExecutor | null = null;
  private contextProvider: (() => SubagentToolContext) | null = null;

  constructor() {
    super(
      'subagent',
      'Spawn Subagent',
      `Spawn an autonomous subagent to work on a task in the background.

The subagent runs independently, using tools as needed, until it completes.
Results appear as a tool result when the subagent finishes.

Use for:
- Deep research tasks requiring multiple searches
- Analysis tasks that need file reading and processing
- Complex operations you want to run in parallel

The subagent has access to all tools via getTools.

To continue a subagent that hit max iterations, provide continueBranchId.`,
      '2.1.0'
    );
  }

  /**
   * Set the subagent executor (called during agent initialization)
   */
  setSubagentExecutor(executor: SubagentExecutor): void {
    this.subagentExecutor = executor;
  }

  /**
   * Set the context provider (called during agent initialization)
   */
  setContextProvider(provider: () => SubagentToolContext): void {
    this.contextProvider = provider;
  }

  async execute(params: SubagentToolParams): Promise<SubagentToolResult> {
    // Validate executor is available
    if (!this.subagentExecutor) {
      return createResult<SubagentToolResult>(
        false,
        null,
        'Subagent executor not initialized'
      );
    }

    // Get execution context
    const context = this.contextProvider?.();
    if (!context) {
      return createResult<SubagentToolResult>(
        false,
        null,
        'Execution context not available'
      );
    }

    // Block MCP clients
    if (context.source === 'mcp') {
      return createResult<SubagentToolResult>(
        false,
        null,
        'Subagent tool is only available in internal chat'
      );
    }

    // Block subagents from spawning subagents
    if (context.isSubagentBranch) {
      return createResult<SubagentToolResult>(
        false,
        null,
        'Subagents cannot spawn other subagents. Ask the parent agent to spawn additional subagents.'
      );
    }

    // Validate task is provided
    if (!params.task) {
      return createResult<SubagentToolResult>(
        false,
        null,
        'Task is required'
      );
    }

    try {
      // Merge context notes: tool params can add more, but inherit parent's too
      const allContextFiles = [
        ...(context.contextNotes || []),
        ...(params.contextFiles || []),
      ];

      const { subagentId, branchId } = await this.subagentExecutor.executeSubagent({
        task: params.task,
        parentConversationId: context.conversationId,
        parentMessageId: context.messageId,
        agent: params.agent,
        tools: params.tools,
        contextFiles: allContextFiles.length > 0 ? allContextFiles : undefined,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        maxIterations: params.maxIterations,
        continueBranchId: params.continueBranchId,
        // Inherit parent's model settings
        provider: context.provider,
        model: context.model,
        // Inherit parent's agent settings
        agentPrompt: context.agentPrompt,
        agentName: context.agentName,
        // Inherit parent's workspace data
        workspaceData: context.workspaceData,
        // Context notes already merged above via contextFiles
        // Inherit parent's thinking settings
        thinkingEnabled: context.thinkingEnabled,
        thinkingEffort: context.thinkingEffort,
      });

      const isContinuing = !!params.continueBranchId;

      return createResult<SubagentToolResult>(true, {
        subagentId,
        branchId,
        status: isContinuing ? 'continued' : 'started',
        message: isContinuing
          ? `Continuing subagent. Branch: ${branchId}`
          : `Subagent started. Working on: "${params.task}". Results will appear when complete.`,
      });
    } catch (error) {
      return createResult<SubagentToolResult>(
        false,
        null,
        `Failed to spawn subagent: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Clear description of what the subagent should accomplish',
        },
        agent: {
          type: 'string',
          description: 'Optional custom agent/persona name to use',
        },
        tools: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'string' },
          },
          description: 'Hand off specific tools to the subagent. Format: { "agentName": ["tool1", "tool2"] }. Tool schemas are pre-filled in subagent system prompt so it can use useTool directly without calling getTools first.',
        },
        contextFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to read - content will be included in the subagent context',
        },
        maxIterations: {
          type: 'number',
          description: 'Maximum iterations before pausing (default: 10)',
        },
        continueBranchId: {
          type: 'string',
          description: 'Branch ID to continue from max_iterations state',
        },
      },
      required: ['task'],
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    const commonSchema = getCommonResultSchema();

    return {
      ...commonSchema,
      properties: {
        ...commonSchema.properties,
        data: {
          oneOf: [
            { type: 'null' },
            {
              type: 'object',
              properties: {
                subagentId: { type: 'string', description: 'Unique ID for the subagent' },
                branchId: { type: 'string', description: 'Branch ID where subagent runs' },
                status: {
                  type: 'string',
                  enum: ['started', 'continued'],
                  description: 'Whether this is a new subagent or continuing existing',
                },
                message: { type: 'string', description: 'Status message' },
              },
              required: ['subagentId', 'branchId', 'status', 'message'],
            },
          ],
        },
      },
    };
  }
}
