import { ITool } from '../../interfaces/ITool';
import { ToolBatchExecutionService } from '../services/ToolBatchExecutionService';
import { ToolCliNormalizer } from '../services/ToolCliNormalizer';
import { NormalizedUseToolParams, UseToolParams, UseToolResult } from '../types';

export class UseToolTool implements ITool<UseToolParams, UseToolResult> {
  slug: string;
  name: string;
  description: string;
  version: string;

  constructor(
    private batchExecutionService: ToolBatchExecutionService,
    private cliNormalizer: ToolCliNormalizer
  ) {
    this.slug = 'useTools';
    this.name = 'Use Tools';
    this.description = 'Execute one or more CLI-style tool commands from the top-level "tool" field. Known-good example: {"workspaceId":"default","sessionId":"session_123","memory":"Summarize work so far.","goal":"Inspect available workspaces.","tool":"memory list-workspaces"}. The chat runtime assigns one sessionId for the conversation; reuse that same sessionId for every useTools call so traces and saved states attach to the current session. IMPORTANT: You MUST call getTools first to inspect the exact command signatures before calling this tool.';
    this.version = '1.0.0';
  }

  async execute(params: UseToolParams): Promise<UseToolResult> {
    const normalizedParams: NormalizedUseToolParams = {
      context: this.cliNormalizer.normalizeContext(params),
      calls: this.cliNormalizer.normalizeExecutionCalls(params),
      strategy: params.strategy
    };
    return this.batchExecutionService.execute(normalizedParams);
  }

  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Workspace ID. Optional. Defaults to "default".'
        },
        sessionId: {
          type: 'string',
          description: 'Current chat session ID. Required. The chat runtime assigns this once per conversation; reuse the same value for every useTools call so traces and saved states attach to the current session.'
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
        },
        tool: {
          type: 'string',
          description: 'CLI-style tool command string. Supports one or more commands separated by commas. Example: "storage move --path notes/a.md --new-path archive/a.md, content read --path archive/a.md".'
        },
        strategy: {
          type: 'string',
          enum: ['serial', 'parallel'],
          description: 'Execution strategy for multiple CLI commands. Defaults to serial.'
        }
      },
      required: ['workspaceId', 'sessionId', 'memory', 'goal', 'tool']
    };
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'True if all commands succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if any commands failed'
        },
        data: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  agent: { type: 'string' },
                  tool: { type: 'string' },
                  params: { type: 'object' },
                  success: { type: 'boolean' },
                  error: { type: 'string' },
                  data: {}
                },
                required: ['agent', 'tool', 'success']
              }
            }
          }
        }
      }
    };
  }
}
