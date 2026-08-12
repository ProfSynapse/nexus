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
    this.description = 'Execute one or more CLI-style tool commands from the top-level "tool" field. Known-good example: {"workspaceId":"default","sessionId":"workspace setup","memory":"Summarize work so far.","goal":"Inspect available workspaces.","tool":"memory list-workspaces"}. Use one stable human-readable session name for the conversation; reuse that same sessionId value for every useTools call so traces and saved states attach to the current session. Nexus stores the internal UUID silently. Multiple commands are separated only by a top-level comma outside quotes, so commas inside quoted values are preserved. For multiline text such as note bodies or Markdown, wrap the value in quotes — literal newlines and escaped ones like "# Title\\n\\nBody" both work, and any double quote inside the value must be escaped as \\". Never flatten multiline content to one line; quoting is enough. For content that is heavy on backslashes, quotes, or length (code, Windows paths, LaTeX, regex), skip CLI escaping entirely: put the text in the optional "values" map and reference it from the tool string as @key — e.g. {"tool":"content write --path x.md --content @body","values":{"body":"...verbatim content..."}}. Values are substituted with no escape processing, so the content arrives exactly as written. When you already know several files you want to read, batch them as comma-separated "content read" commands in ONE call with strategy "parallel" — do not issue a separate useTools call per file. IMPORTANT: You MUST call getTools first to inspect the exact command signatures before calling this tool.';
    this.version = '1.0.0';
  }

  async execute(params: UseToolParams): Promise<UseToolResult> {
    // Enforce the required context contract (memory + goal) before executing.
    // Throws a recoverable steering error the model can self-correct from —
    // matching how malformed CLI flags already steer in normalizeExecutionCalls.
    this.cliNormalizer.validateExecutionContext(params);

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
          description: 'CLI-style tool command string. Supports one or more commands separated by commas. Only top-level commas split commands; commas inside quoted values stay literal. For multiline content, quote the value — literal newlines and escaped \\n both work, and embedded double quotes must be escaped as \\" (e.g. "content write --path note.md --content "# Title\\n\\nBody""). Example: "storage move --path notes/a.md --new-path archive/a.md, content read --path archive/a.md". Reading multiple known files? Batch them here as one comma-separated list (e.g. "content read --path a.md, content read --path b.md, content read --path c.md") instead of separate calls.'
        },
        strategy: {
          type: 'string',
          enum: ['serial', 'parallel'],
          description: 'Execution strategy for multiple CLI commands. Defaults to serial. Use "parallel" for independent read-only commands (e.g. batched content reads) to avoid wasted round-trips.'
        },
        values: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional verbatim payloads, referenced from the tool string as @key (unquoted). Substituted after parsing with NO escape processing — backslashes, quotes, and newlines arrive exactly as written, so use this for code, Windows paths, LaTeX, regex, or any long multiline body instead of CLI-escaping it. Keys use letters, digits, "_" or "-". Quote a token ("@key") to pass the literal text @key instead. Every declared key must be referenced. Example: {"tool":"memory create-state --name \\"x\\" --conversation-context @ctx ...","values":{"ctx":"## Context\\nPath C:\\\\temp — said \\"hi\\""}}.'
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
