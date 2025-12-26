/**
 * UseToolTool - Execution tool for the two-tool architecture
 * Single entry point for executing tools with context-first design
 *
 * Note: This tool implements ITool directly instead of extending BaseTool
 * because it uses a different context format (ToolContext) than CommonParameters.
 */

import { App } from 'obsidian';
import { ITool } from '../../interfaces/ITool';
import { UseToolParams, UseToolResult, ToolCallParams, ToolCallResult, ToolContext, getToolContextSchema } from '../types';
import { IAgent } from '../../interfaces/IAgent';
import { getErrorMessage } from '../../../utils/errorUtils';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { WorkspaceService } from '../../../services/WorkspaceService';

/** Workspace info for validation */
interface WorkspaceInfo {
  name: string;
  description?: string;
}

/**
 * Tool for executing other tools with unified context
 * Implements ITool directly since UseToolParams has its own context format
 */
export class UseToolTool implements ITool<UseToolParams, UseToolResult> {
  slug: string;
  name: string;
  description: string;
  version: string;

  private app: App;
  private agentRegistry: Map<string, IAgent>;
  private knownWorkspaces: WorkspaceInfo[];

  /**
   * Create a new UseToolTool
   * @param app Obsidian app instance
   * @param agentRegistry Map of agent name to agent instance
   * @param workspaces Known workspaces for validation by name
   */
  constructor(app: App, agentRegistry: Map<string, IAgent>, workspaces: WorkspaceInfo[] = []) {
    this.slug = 'useTools';
    this.name = 'Use Tools';
    this.description = 'Execute tools with context. Fill context FIRST (memory→goal→constraints), then specify tools to call. Context ensures memory/goal are captured for each trace.';
    this.version = '1.0.0';

    this.app = app;
    this.agentRegistry = agentRegistry;
    this.knownWorkspaces = workspaces;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with execution results
   */
  async execute(params: UseToolParams): Promise<UseToolResult> {
    try {
      // Validate context
      const contextErrors = this.validateContext(params.context);
      if (contextErrors.length > 0) {
        return {
          success: false,
          error: `Invalid context: ${contextErrors.join(', ')}`
        };
      }

      // Validate workspaceId exists
      const workspaceError = await this.validateWorkspaceId(params.context.workspaceId);
      if (workspaceError) {
        return {
          success: false,
          error: workspaceError
        };
      }

      // Validate calls array
      if (!params.calls || params.calls.length === 0) {
        return {
          success: false,
          error: 'At least one tool call is required. The "calls" array cannot be empty.'
        };
      }

      // Execute based on strategy
      const strategy = params.strategy || 'serial';
      let results: ToolCallResult[];

      if (strategy === 'parallel') {
        results = await this.executeParallel(params.context, params.calls);
      } else {
        results = await this.executeSerial(params.context, params.calls);
      }

      // Determine overall success
      const allSucceeded = results.every(r => r.success);
      const anyFailed = results.some(r => !r.success);

      // Build result
      const result: UseToolResult = {
        success: allSucceeded,
        data: {
          results
        }
      };

      // Add error message if any failed
      if (anyFailed) {
        const failedTools = results.filter(r => !r.success).map(r => `${r.agent}_${r.tool}`);
        result.error = `Some tools failed: ${failedTools.join(', ')}`;
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: `Error executing tools: ${getErrorMessage(error)}`
      };
    }
  }

  /**
   * Validate the context block
   */
  private validateContext(context: ToolContext): string[] {
    const errors: string[] = [];

    if (!context) {
      errors.push('context is required');
      return errors;
    }

    if (!context.workspaceId || typeof context.workspaceId !== 'string') {
      errors.push('context.workspaceId is required');
    }

    if (!context.sessionId || typeof context.sessionId !== 'string') {
      errors.push('context.sessionId is required');
    }

    if (!context.memory || typeof context.memory !== 'string') {
      errors.push('context.memory is required (1-3 sentences describing conversation essence)');
    }

    if (!context.goal || typeof context.goal !== 'string') {
      errors.push('context.goal is required (1-3 sentences describing current objective)');
    }

    // constraints is optional, but if provided should be a string
    if (context.constraints !== undefined && context.constraints !== null && typeof context.constraints !== 'string') {
      errors.push('context.constraints must be a string if provided');
    }

    return errors;
  }

  /**
   * Validate workspaceId exists (by name or UUID)
   * Returns error message with available workspaces if invalid, null if valid
   */
  private async validateWorkspaceId(workspaceId: string): Promise<string | null> {
    // "default" is always valid (global workspace)
    if (workspaceId === 'default') {
      return null;
    }

    // First, check if it matches a known workspace NAME (case-insensitive)
    const byName = this.knownWorkspaces.find(w =>
      w.name.toLowerCase() === workspaceId.toLowerCase()
    );
    if (byName) {
      return null; // Valid - matched by name
    }

    // If not found by name, check if it's a valid UUID via WorkspaceService
    try {
      const plugin = getNexusPlugin(this.app);
      if (!plugin) {
        return null; // Plugin not ready, allow to proceed
      }

      const workspaceService = (plugin as { workspaceService?: WorkspaceService }).workspaceService;
      if (!workspaceService) {
        return null; // Service not ready, allow to proceed
      }

      // Check if it matches by UUID
      const workspaces = await workspaceService.listWorkspaces();
      const byUuid = workspaces.find(w => w.id === workspaceId);
      if (byUuid) {
        return null; // Valid - matched by UUID
      }

      // Not found - build error message with available workspace NAMES
      const availableNames = this.knownWorkspaces.length > 0
        ? this.knownWorkspaces.map(w => `"${w.name}"`).join(', ')
        : '(none created yet)';
      return `Invalid workspace "${workspaceId}". Available: "default" (global), ${availableNames}`;
    } catch {
      return null; // Error, allow to proceed
    }
  }

  /**
   * Execute calls serially (one at a time)
   * Stops on first error unless continueOnFailure is set
   */
  private async executeSerial(context: ToolContext, calls: ToolCallParams[]): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = [];

    for (const call of calls) {
      const result = await this.executeCall(context, call);
      results.push(result);

      // Stop on failure unless continueOnFailure is set
      if (!result.success && !call.continueOnFailure) {
        break;
      }
    }

    return results;
  }

  /**
   * Execute calls in parallel
   */
  private async executeParallel(context: ToolContext, calls: ToolCallParams[]): Promise<ToolCallResult[]> {
    const promises = calls.map(call => this.executeCall(context, call));
    return Promise.all(promises);
  }

  /**
   * Execute a single tool call
   */
  private async executeCall(context: ToolContext, call: ToolCallParams): Promise<ToolCallResult> {
    const { agent: agentName, tool: toolSlug } = call;

    // Handle LLM confusion: accept both "params" and "parameters"
    const callWithAny = call as ToolCallParams & { parameters?: Record<string, unknown> };
    const params = call.params || callWithAny.parameters || {};

    // Validate agent and tool are provided
    if (!agentName) {
      return {
        agent: agentName || 'unknown',
        tool: toolSlug || 'unknown',
        success: false,
        error: 'agent is required in each call'
      };
    }

    if (!toolSlug) {
      return {
        agent: agentName,
        tool: 'unknown',
        success: false,
        error: 'tool is required in each call'
      };
    }

    // Get agent
    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      return {
        agent: agentName,
        tool: toolSlug,
        success: false,
        error: `Agent "${agentName}" not found. Use getTools to discover available agents.`
      };
    }

    // Check tool exists
    const toolInstance = agent.getTool(toolSlug);
    if (!toolInstance) {
      const availableTools = agent.getTools().map(t => t.slug).join(', ');
      return {
        agent: agentName,
        tool: toolSlug,
        success: false,
        error: `Tool "${toolSlug}" not found in agent "${agentName}". Available tools: ${availableTools}`
      };
    }

    try {
      // Execute tool with ONLY its specific params
      // Context is handled at useTool level - individual tools don't need it
      const toolResult = await toolInstance.execute(params || {});

      // Build minimal result
      const result: ToolCallResult = {
        agent: agentName,
        tool: toolSlug,
        success: toolResult.success
      };

      // Only include error if failed
      if (!toolResult.success && toolResult.error) {
        result.error = toolResult.error;
      }

      // Only include data if present (for tools that return data)
      if (toolResult.success && toolResult.data !== undefined && toolResult.data !== null) {
        result.data = toolResult.data;
      }

      return result;
    } catch (error) {
      return {
        agent: agentName,
        tool: toolSlug,
        success: false,
        error: `Error executing ${agentName}_${toolSlug}: ${getErrorMessage(error)}`
      };
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   */
  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        context: getToolContextSchema(),
        strategy: {
          type: 'string',
          enum: ['serial', 'parallel'],
          default: 'serial',
          description: 'Execution strategy: serial (stop on error) or parallel (run all)'
        },
        calls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agent: {
                type: 'string',
                description: 'Agent name (e.g., "vaultManager", "agentManager")'
              },
              tool: {
                type: 'string',
                description: 'Tool name (e.g., "listDirectory", "subagent")'
              },
              params: {
                type: 'object',
                description: 'Tool-specific parameters ONLY (NOT sessionId/workspaceId - those go in context). Example for subagent: { "task": "research topic X" }'
              },
              continueOnFailure: {
                type: 'boolean',
                description: 'Continue despite errors for this call (serial only)'
              }
            },
            required: ['agent', 'tool', 'params']
          },
          minItems: 1,
          description: 'Tool calls to execute. Use "params" (not "parameters") for tool-specific args.'
        }
      },
      required: ['context', 'calls']
    };
  }

  /**
   * Get the JSON schema for the tool's result
   */
  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'True if all calls succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if any calls failed'
        },
        data: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  agent: { type: 'string', description: 'Agent that executed the tool' },
                  tool: { type: 'string', description: 'Tool that was executed' },
                  success: { type: 'boolean', description: 'Whether this call succeeded' },
                  error: { type: 'string', description: 'Error message if failed' },
                  data: { description: 'Result data (only for tools that return data)' }
                },
                required: ['agent', 'tool', 'success']
              }
            }
          }
        }
      },
      required: ['success']
    };
  }
}
