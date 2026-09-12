import { ITool } from '../../interfaces/ITool';
import type { ToolExecutionPolicy } from '../../policy/ToolExecutionPolicy';
import { CONSERVATIVE_TOOL_EXECUTION_POLICY } from '../../policy/ToolExecutionPolicy';
import { ToolBatchExecutionService } from '../services/ToolBatchExecutionService';
import { ToolCliNormalizer } from '../services/ToolCliNormalizer';
import { NormalizedUseToolParams, UseToolParams, UseToolResult } from '../types';
import {
  CLI_BATCHING_RULE,
  CLI_MULTILINE_RULE,
  CLI_MULTILINE_EXAMPLE,
  CLI_VALUES_RULE,
  CLI_VALUES_EXAMPLE
} from '../guidance';

export class UseToolTool implements ITool<UseToolParams, UseToolResult> {
  slug: string;
  name: string;
  description: string;
  version: string;

  getExecutionPolicy(): Readonly<ToolExecutionPolicy> {
    return CONSERVATIVE_TOOL_EXECUTION_POLICY;
  }

  constructor(
    private batchExecutionService: ToolBatchExecutionService,
    private cliNormalizer: ToolCliNormalizer
  ) {
    this.slug = 'useTools';
    this.name = 'Use Tools';
    this.description = 'Execute one or more CLI-style tool commands from the top-level "tool" field. Known-good example: {"sessionId":"workspace setup","memory":"Summarize work so far.","goal":"Inspect available workspaces.","tool":"memory list-workspaces"}. The workspace is remembered per session: a fresh session passes "workspaceId" once ("default" or an exact name from getTools) or loads one with "memory load-workspace"; every later call in that session inherits it, so omit "workspaceId" unless you are deliberately switching. Use one stable human-readable session name for the conversation; reuse that same sessionId value for every useTools call so traces and saved states attach to the current session. Nexus stores the internal UUID silently. '
      + CLI_BATCHING_RULE + ' '
      + CLI_MULTILINE_RULE + ' '
      + CLI_VALUES_RULE + ' Example: ' + CLI_VALUES_EXAMPLE
      + '. When you already know several files you want to read, batch them as comma-separated "content read" commands in ONE call with strategy "parallel" — do not issue a separate useTools call per file. IMPORTANT: You MUST call getTools first to inspect the exact command signatures before calling this tool.';
    this.version = '1.0.0';
  }

  async execute(params: UseToolParams): Promise<UseToolResult> {
    // Enforce the required context contract (memory + goal) before executing.
    // Throws a recoverable steering error the model can self-correct from —
    // matching how malformed CLI flags already steer in normalizeExecutionCalls.
    this.cliNormalizer.validateExecutionContext(params);
    if (params.operationId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(params.operationId)) {
      throw new Error('operationId must be 1-128 characters using letters, digits, period, underscore, colon, or hyphen. Reuse it only for an exact retry.');
    }

    const normalizedParams: NormalizedUseToolParams = {
      context: this.cliNormalizer.normalizeContext(params),
      calls: this.cliNormalizer.normalizeExecutionCalls(params),
      strategy: params.strategy
    };
    return this.batchExecutionService.execute(normalizedParams, {
      operationId: params.operationId,
      operationOrigin: 'external-mcp',
      operationReplayable: Boolean(params.operationId),
    });
  }

  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Workspace name or ID. Pass it once to choose or switch the workspace for this session; later calls in the same session inherit it, so omit it otherwise. A fresh session must pass it once (or run "memory load-workspace") before other commands — "default" for the global workspace, or an exact value from the availableWorkspaces list returned by getTools. An empty string is read as omitted, never as "default".'
        },
        sessionId: {
          type: 'string',
          description: 'Stable human-readable session name for this chat. Reuse the same value for every useTools call so traces, saved states and the remembered workspace attach to the current session; Nexus stores the internal UUID silently. Omit it only when the runtime already supplies the session.'
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
          description: 'CLI-style tool command string. '
            + CLI_BATCHING_RULE + ' '
            + CLI_MULTILINE_RULE + ' Example: ' + CLI_MULTILINE_EXAMPLE
            + '. Batching example: "storage move --path notes/a.md --new-path archive/a.md, content read --path archive/a.md". Reading multiple known files? Batch them here as one comma-separated list (e.g. "content read --path a.md, content read --path b.md, content read --path c.md") instead of separate calls.'
        },
        strategy: {
          type: 'string',
          enum: ['serial', 'parallel'],
          description: 'Execution strategy for multiple CLI commands. Defaults to serial. Use "parallel" for independent read-only commands (e.g. batched content reads) to avoid wasted round-trips.'
        },
        operationId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          description: 'Optional stable retry identity. Reuse the same value only for an exact retry; reusing it with different command parameters is rejected. Calls without it receive a non-replayable generated receipt and cannot be deduplicated across retries.'
        },
        values: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: CLI_VALUES_RULE
            + ' Keys use letters, digits, "_" or "-". Example: ' + CLI_VALUES_EXAMPLE
        }
      },
      // workspaceId and sessionId are deliberately NOT required (#214): the
      // workspace is inherited from the session's bind after the first call,
      // and on the MCP path `required` IS enforced (ValidationService), so
      // listing it would force every call to restate it. Requiredness of the
      // FIRST call is enforced where it can see the session — in
      // ToolCliNormalizer.normalizeRequiredWorkspaceId — not by the schema.
      required: ['memory', 'goal', 'tool']
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
