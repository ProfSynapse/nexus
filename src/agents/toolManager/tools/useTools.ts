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
    this.description = 'Execute one or more CLI-style tool commands from the top-level "tool" field. Known-good example: {"workspaceId":"default","sessionId":"workspace setup","memory":"Summarize work so far.","goal":"Inspect available workspaces.","tool":"memory list-workspaces"}. Use one stable human-readable session name for the conversation; reuse that same sessionId value for every useTools call so traces and saved states attach to the current session. Nexus stores the internal UUID silently. Multiple commands are separated only by a top-level comma outside quotes, so commas inside quoted values are preserved. For multiline text such as note bodies or Markdown, wrap the value in quotes and use escaped newlines like \"# Title\\n\\nBody\"; the parser decodes them before execution. When you already know several files you want to read, batch them as comma-separated "content read" commands in ONE call with strategy "parallel" — do not issue a separate useTools call per file. IMPORTANT: You MUST call getTools first to inspect the exact command signatures before calling this tool.';
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
          description: 'Stable human-readable session name for this chat. Required. Reuse the same value for every useTools call so traces and saved states attach to the current session; Nexus stores the internal UUID silently.'
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
          description: 'CLI-style tool command string. Supports one or more commands separated by commas. Only top-level commas split commands; commas inside quoted values stay literal. For multiline content, quote the value and use escaped newlines such as "content write --path note.md --content \"# Title\\n\\nBody\"". Example: "storage move --path notes/a.md --new-path archive/a.md, content read --path archive/a.md". Reading multiple known files? Batch them here as one comma-separated list (e.g. "content read --path a.md, content read --path b.md, content read --path c.md") instead of separate calls.'
        },
        strategy: {
          type: 'string',
          enum: ['serial', 'parallel'],
          description: 'Execution strategy for multiple CLI commands. Defaults to serial. Use "parallel" for independent read-only commands (e.g. batched content reads) to avoid wasted round-trips.'
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
