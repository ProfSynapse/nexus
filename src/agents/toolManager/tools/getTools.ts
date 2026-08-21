import { ITool } from '../../interfaces/ITool';
import { IAgent } from '../../interfaces/IAgent';
import { getErrorMessage } from '../../../utils/errorUtils';
import { SchemaData, WorkspaceNameProvider } from '../toolManager';
import { GetToolsParams, GetToolsResult } from '../types';
import { ToolCliNormalizer } from '../services/ToolCliNormalizer';

const INTERNAL_ONLY_TOOLS = new Set<string>([]);

/** Cap on workspace names echoed back per discovery call. */
const MAX_LISTED_WORKSPACES = 40;

/**
 * How long a live workspace lookup is reused. Discovery is often several calls
 * in a row; the list does not change between them.
 */
const WORKSPACE_CACHE_TTL_MS = 5000;

export class GetToolsTool implements ITool<GetToolsParams, GetToolsResult> {
  slug: string;
  name: string;
  description: string;
  version: string;

  private agentRegistry: Map<string, IAgent>;
  private cliNormalizer: ToolCliNormalizer;
  private schemaData: SchemaData;
  private workspaceProvider?: WorkspaceNameProvider;
  private workspaceCache: { names: string[]; fetchedAt: number } | null = null;

  constructor(
    agentRegistry: Map<string, IAgent>,
    schemaData: SchemaData,
    workspaceProvider?: WorkspaceNameProvider
  ) {
    this.slug = 'getTools';
    this.name = 'Get Tools';
    this.version = '1.0.0';
    this.agentRegistry = agentRegistry;
    this.cliNormalizer = new ToolCliNormalizer(agentRegistry);
    this.schemaData = schemaData;
    this.workspaceProvider = workspaceProvider;
    this.description = this.buildDescription(schemaData);
  }

  refreshDescription(schemaData?: SchemaData): void {
    if (schemaData) {
      this.schemaData = schemaData;
    }
    this.description = this.buildDescription(this.schemaData);
  }

  private buildDescription(schemaData: SchemaData): string {
    const lines = [
      'REQUIRED FIRST STEP: You MUST call getTools BEFORE calling useTools.',
      'This returns CLI-oriented command metadata for the tools you need next.',
      'Send workspaceId, sessionId, memory, goal, and constraints at the top level.',
      'Use one stable human-readable session name for the conversation. Reuse that same sessionId value for every getTools/useTools call in the chat; do not invent a new sessionId per tool or per saved state. Nexus stores an internal UUID silently.',
      'Do not send a nested "context" object or legacy "request" array.',
      '',
      'Workflow: 1) Call getTools with one or more selectors → 2) Call useTools with one or more CLI-style commands',
      'Known-good example: {"workspaceId":"default","sessionId":"workspace setup","memory":"Summarize work so far.","goal":"Inspect available storage tools.","tool":"storage move, content read"}',
      'Example selectors: tool="--help", tool="storage", tool="storage move", tool="storage move, content read"',
      '',
      'Agents:'
    ];

    for (const [agentName, agent] of this.agentRegistry) {
      if (agentName === 'toolManager') continue;
      const tools = agent.getTools()
        .map(tool => tool.slug)
        .filter(slug => !INTERNAL_ONLY_TOOLS.has(slug));
      if (tools.length > 0) {
        const alias = this.cliNormalizer.getAgentAlias(agentName);
        lines.push(`${alias}: [${tools.join(',')}]`);
      }
    }

    if (schemaData.customAgents.length > 0) {
      lines.push('');
      lines.push('Custom Agents:');
      for (const agent of schemaData.customAgents) {
        lines.push(`- "${agent.name}": ${agent.description || 'No description'}`);
      }
    }

    lines.push('');
    // Only claim to enumerate workspaces when we actually have them. This
    // description is built from a boot snapshot that is routinely empty (the
    // storage adapter is created seconds after agents register), and the old
    // unconditional "[default]" asserted that default was the ONLY workspace —
    // a confident falsehood on every vault that had others. That is what sent
    // agents off inventing a name from the user's phrasing.
    if (schemaData.workspaces.length > 0) {
      lines.push(`Existing workspaces (exact names — never invent one): [default,${schemaData.workspaces.map(w => w.name).join(',')}]`);
    } else {
      lines.push('Existing workspaces: not listed here. The getTools RESULT carries the live list — read "workspaces" there and pass one of those exact names. Never infer a workspace name from the user\'s wording.');
    }

    if (schemaData.vaultRoot.length > 0) {
      const folders = schemaData.vaultRoot.slice(0, 5);
      if (schemaData.vaultRoot.length > 5) folders.push('...');
      lines.push(`Vault: [${folders.join(',')}]`);
    }

    return lines.join('\n');
  }

  /**
   * Current workspace names, live where possible.
   *
   * Falls back to the boot snapshot when no provider is wired or the lookup
   * fails — a stale list still beats no list, since an empty one is what makes
   * agents guess names.
   */
  private async getWorkspaceNames(): Promise<string[]> {
    const snapshot = this.schemaData.workspaces.map(workspace => workspace.name);

    if (!this.workspaceProvider) {
      return snapshot;
    }

    const now = Date.now();
    if (this.workspaceCache && now - this.workspaceCache.fetchedAt < WORKSPACE_CACHE_TTL_MS) {
      return this.workspaceCache.names;
    }

    try {
      const workspaces = await this.workspaceProvider();
      const names = workspaces.map(workspace => workspace.name).filter(Boolean);
      this.workspaceCache = { names, fetchedAt: now };

      // Heal the boot snapshot. The description is what MCP clients read from
      // tools/list, and it cannot be re-fetched on demand — so the first live
      // lookup writes the real names back into it. Every later tools/list (a
      // fresh CLI invocation, a reconnecting client) then sees the truth
      // instead of the empty boot-time list.
      if (names.length > 0 && !this.sameNames(snapshot, names)) {
        this.schemaData = {
          ...this.schemaData,
          workspaces: workspaces.map(workspace => ({
            name: workspace.name,
            description: workspace.description
          }))
        };
        this.description = this.buildDescription(this.schemaData);
      }

      return names;
    } catch {
      return snapshot;
    }
  }

  private sameNames(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((name, index) => name === b[index]);
  }

  async execute(params: GetToolsParams): Promise<GetToolsResult> {
    try {
      const requests = this.cliNormalizer.normalizeDiscoveryRequests(params);
      const resultSchemas = [];
      const notFound: string[] = [];
      // A broad/agent-level selector (`--help` or just an agent name) lists tools COMPACTLY
      // — command + description only — so discovery never re-dumps every tool's full args
      // and examples (that catalog was ~25k tokens and persisted in chat history). The model
      // drills into a specific "agent tool" to get the full signature before calling it.
      let returnedCompact = false;

      for (const item of requests) {
        const agent = this.agentRegistry.get(item.agent);
        if (!agent) {
          notFound.push(`Agent "${item.agent}" not found`);
          continue;
        }

        if (!item.tools || item.tools.length === 0) {
          const allTools = agent.getTools().filter(tool => !INTERNAL_ONLY_TOOLS.has(tool.slug));
          for (const tool of allTools) {
            resultSchemas.push(this.cliNormalizer.buildCliSchema(item.agent, tool, { compact: true }));
          }
          returnedCompact = true;
          continue;
        }

        for (const toolSlug of item.tools) {
          if (INTERNAL_ONLY_TOOLS.has(toolSlug)) {
            notFound.push(`Tool "${toolSlug}" not found in agent "${item.agent}"`);
            continue;
          }

          const tool = agent.getTool(toolSlug);
          if (!tool) {
            notFound.push(`Tool "${toolSlug}" not found in agent "${item.agent}"`);
            continue;
          }

          resultSchemas.push(this.cliNormalizer.buildCliSchema(item.agent, tool));
        }
      }

      // The live workspace list rides along on every discovery call. Workspace
      // names are the one argument agents habitually invent (they read one out
      // of the user's phrasing), and discovery is the last step before they
      // commit to one — so the real names have to be in front of them here,
      // not just in a description built at boot when the list may still have
      // been empty.
      const workspaceNames = await this.getWorkspaceNames();
      const listedWorkspaces = ['default', ...workspaceNames.slice(0, MAX_LISTED_WORKSPACES)];
      const workspacesTruncated = workspaceNames.length > MAX_LISTED_WORKSPACES;

      return {
        success: true,
        ...(notFound.length > 0 ? { error: `Some items not found: ${notFound.join(', ')}` } : {}),
        data: {
          tools: resultSchemas,
          workspaces: listedWorkspaces,
          workspacesNote: workspacesTruncated
            ? `These are the only workspaces that exist (first ${MAX_LISTED_WORKSPACES} of ${workspaceNames.length}; use "memory search-workspaces" for the rest). Pass one of these exact names — do not infer a workspace name from the user's wording.`
            : 'These are the only workspaces that exist. Pass one of these exact names — do not infer a workspace name from the user\'s wording.',
          ...(returnedCompact
            ? { note: 'Compact list (command + description). For a tool\'s full arguments and examples, call getTools with a specific "agent tool" selector (e.g. "storage move") before using it.' }
            : {})
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Error getting tools: ${getErrorMessage(error)}`
      };
    }
  }

  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Workspace name or ID. Required, and must be non-empty — an empty string is rejected, not read as "default". Pass "default" for the global workspace, or an exact value from the availableWorkspaces list this call returns.'
        },
        sessionId: {
          type: 'string',
          description: 'Stable human-readable session name for this chat. Required. Reuse the same value for every getTools/useTools call so traces and saved states attach to the current session; Nexus stores the internal UUID silently.'
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
          description: 'CLI-style selector string. Supports one or more selectors separated by commas. Examples: "--help", "storage", "storage move", "storage move, content read".'
        }
      },
      required: ['workspaceId', 'sessionId', 'memory', 'goal', 'tool']
    };
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        error: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  agent: { type: 'string' },
                  tool: { type: 'string' },
                  description: { type: 'string' },
                  command: { type: 'string' },
                  usage: { type: 'string' },
                  arguments: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        flag: { type: 'string' },
                        type: { type: 'string' },
                        required: { type: 'boolean' },
                        positional: { type: 'boolean' },
                        description: { type: 'string' }
                      },
                      required: ['name', 'flag', 'type', 'required', 'positional']
                    }
                  },
                  examples: {
                    type: 'array',
                    items: { type: 'string' }
                  }
                },
                // usage/arguments/examples are present only for FULL schemas (a specific
                // "agent tool" request); broad discovery returns compact entries.
                required: ['agent', 'tool', 'description', 'command']
              }
            },
            workspaces: {
              type: 'array',
              items: { type: 'string' },
              description: 'Every workspace that currently exists. These are the only valid values for a workspace name or workspaceId — pass one verbatim, never a name inferred from the user\'s wording.'
            },
            workspacesNote: { type: 'string' },
            note: { type: 'string' }
          }
        }
      },
      required: ['success']
    };
  }
}
