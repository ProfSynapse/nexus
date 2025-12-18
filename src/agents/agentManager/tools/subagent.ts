/**
 * SubagentTool - Spawn an autonomous subagent to work on a task
 *
 * The subagent runs independently in a branch, using tools as needed,
 * until it completes the task (responds without tool calls).
 *
 * This tool is INTERNAL ONLY - hidden from MCP/Claude Desktop clients.
 */

import { BaseTool } from '../../baseTool';
import { getCommonResultSchema, createResult } from '../../../utils/schemaUtils';
import { CommonParameters, CommonResult } from '../../../types';
import type { SubagentExecutor } from '../../../services/chat/SubagentExecutor';

export interface SubagentToolParams extends CommonParameters {
  task: string;
  agent?: string;
  // Pre-fetched tools: { agentName: [toolSlug1, toolSlug2] }
  tools?: Record<string, string[]>;
  contextFiles?: string[];
  additionalContext?: string;  // Renamed from 'context' to avoid conflict with CommonParameters
  maxIterations?: number;
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
 */
export interface SubagentToolContext {
  conversationId: string;
  messageId: string;
  workspaceId?: string;
  sessionId?: string;
  source?: 'internal' | 'mcp';
  isSubagentBranch?: boolean;
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

The subagent has access to all tools via getTools (except spawning more subagents).

To continue a subagent that hit max iterations, call with continueBranchId.`,
      '1.0.0'
    );
    console.log('[SubagentTool] Constructor called');
  }

  /**
   * Set the subagent executor (called during agent initialization)
   */
  setSubagentExecutor(executor: SubagentExecutor): void {
    console.log('[SubagentTool] setSubagentExecutor called, executor:', !!executor);
    this.subagentExecutor = executor;
  }

  /**
   * Set the context provider (called during agent initialization)
   */
  setContextProvider(provider: () => SubagentToolContext): void {
    console.log('[SubagentTool] setContextProvider called');
    this.contextProvider = provider;
  }

  async execute(params: SubagentToolParams): Promise<SubagentToolResult> {
    console.log('[SubagentTool] execute called with params:', {
      task: params.task,
      agent: params.agent,
      hasTools: params.tools ? Object.keys(params.tools).length : 0,
      contextFilesCount: params.contextFiles?.length || 0,
      maxIterations: params.maxIterations,
      continueBranchId: params.continueBranchId,
    });

    // Validate executor is available
    if (!this.subagentExecutor) {
      console.error('[SubagentTool] ✗ Subagent executor not initialized');
      return createResult<SubagentToolResult>(
        false,
        null,
        'Subagent executor not initialized'
      );
    }
    console.log('[SubagentTool] ✓ Subagent executor available');

    // Get execution context
    const context = this.contextProvider?.();
    if (!context) {
      console.error('[SubagentTool] ✗ Execution context not available');
      return createResult<SubagentToolResult>(
        false,
        null,
        'Execution context not available'
      );
    }
    console.log('[SubagentTool] ✓ Execution context:', context);

    // Block MCP clients
    if (context.source === 'mcp') {
      console.warn('[SubagentTool] ✗ Blocked MCP client attempt');
      return createResult<SubagentToolResult>(
        false,
        null,
        'Subagent tool is only available in internal chat'
      );
    }

    // Block subagents from spawning subagents
    if (context.isSubagentBranch) {
      console.warn('[SubagentTool] ✗ Blocked subagent from spawning another subagent');
      return createResult<SubagentToolResult>(
        false,
        null,
        'Subagents cannot spawn other subagents. Ask the parent agent to spawn additional subagents.'
      );
    }

    try {
      console.log('[SubagentTool] Calling subagentExecutor.executeSubagent...');
      const { subagentId, branchId } = await this.subagentExecutor.executeSubagent({
        task: params.task,
        parentConversationId: context.conversationId,
        parentMessageId: context.messageId,
        agent: params.agent,
        tools: params.tools,
        contextFiles: params.contextFiles,
        context: params.additionalContext,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        maxIterations: params.maxIterations,
        continueBranchId: params.continueBranchId,
      });

      const isContinuing = !!params.continueBranchId;

      console.log('[SubagentTool] ✓ Subagent spawned:', { subagentId, branchId, isContinuing });

      return createResult<SubagentToolResult>(true, {
        subagentId,
        branchId,
        status: isContinuing ? 'continued' : 'started',
        message: isContinuing
          ? `Continuing subagent. Branch: ${branchId}`
          : `Subagent started. Working on: "${params.task}". Results will appear when complete.`,
      });
    } catch (error) {
      console.error('[SubagentTool] ✗ Failed to spawn subagent:', error);
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
          description: 'Optional custom agent/persona name to use (from agentManager)',
        },
        tools: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'string' },
          },
          description:
            'Pre-fetched tools by agent name. Format: { agentName: [toolSlug1, toolSlug2] }. Schemas included in initial context.',
        },
        contextFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to read and include as context',
        },
        additionalContext: {
          type: 'string',
          description: 'Additional context to provide to the subagent',
        },
        maxIterations: {
          type: 'number',
          description: 'Maximum iterations before pausing (default: 10)',
        },
        continueBranchId: {
          type: 'string',
          description:
            'Branch ID of existing subagent to continue (from previous max_iterations result)',
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
