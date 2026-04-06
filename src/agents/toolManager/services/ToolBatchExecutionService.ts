import { App } from 'obsidian';
import { IAgent } from '../../interfaces/IAgent';
import { CommonResult } from '../../../types';
import { ToolCallParams, ToolCallResult, ToolContext, UseToolParams, UseToolResult } from '../types';
import { getErrorMessage } from '../../../utils/errorUtils';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { WorkspaceService } from '../../../services/WorkspaceService';

export interface ToolManagerWorkspaceInfo {
  name: string;
  description?: string;
}

export interface ToolBatchStartedEvent {
  batchId: string;
  context: ToolContext;
  strategy: 'serial' | 'parallel';
  calls: ToolCallParams[];
  totalCalls: number;
}

export interface ToolBatchStepEvent {
  batchId: string;
  stepId: string;
  callIndex: number;
  totalCalls: number;
  context: ToolContext;
  strategy: 'serial' | 'parallel';
  call: ToolCallParams;
}

export interface ToolBatchStepCompletedEvent extends ToolBatchStepEvent {
  result: ToolCallResult;
}

export interface ToolBatchCompletedEvent extends ToolBatchStartedEvent {
  results: ToolCallResult[];
  success: boolean;
}

export interface ToolBatchExecutionObserver {
  onBatchStarted?(event: ToolBatchStartedEvent): void;
  onStepStarted?(event: ToolBatchStepEvent): void;
  onStepCompleted?(event: ToolBatchStepCompletedEvent): void;
  onBatchCompleted?(event: ToolBatchCompletedEvent): void;
}

export interface ToolBatchExecutionOptions {
  observer?: ToolBatchExecutionObserver;
  batchId?: string;
}

/**
 * Shared execution service for the two-tool architecture.
 *
 * This contains the one source of truth for useTools validation, serial vs parallel
 * execution, and result formatting. Callers can optionally observe batch and step
 * lifecycle events without changing the underlying execution behavior.
 */
export class ToolBatchExecutionService {
  constructor(
    private app: App,
    private agentRegistry: Map<string, IAgent>,
    private knownWorkspaces: ToolManagerWorkspaceInfo[] = []
  ) {}

  async execute(params: UseToolParams, options: ToolBatchExecutionOptions = {}): Promise<UseToolResult> {
    try {
      const contextErrors = this.validateContext(params.context);
      if (contextErrors.length > 0) {
        return {
          success: false,
          error: `Invalid context: ${contextErrors.join(', ')}`
        };
      }

      const workspaceError = await this.validateWorkspaceId(params.context.workspaceId);
      if (workspaceError) {
        return {
          success: false,
          error: workspaceError
        };
      }

      if (!params.calls || params.calls.length === 0) {
        return {
          success: false,
          error: 'calls array is required. Structure: calls: [{ agent: "agentName", tool: "toolName", params: {...} }]'
        };
      }

      const strategy = params.strategy || 'serial';
      const batchId = options.batchId || this.createBatchId();
      const batchStartedEvent: ToolBatchStartedEvent = {
        batchId,
        context: params.context,
        strategy,
        calls: params.calls,
        totalCalls: params.calls.length
      };

      options.observer?.onBatchStarted?.(batchStartedEvent);

      const results = strategy === 'parallel'
        ? await this.executeParallel(batchId, params.context, params.calls, options.observer)
        : await this.executeSerial(batchId, params.context, params.calls, options.observer);

      const success = results.every(result => result.success);
      options.observer?.onBatchCompleted?.({
        ...batchStartedEvent,
        results,
        success
      });

      return this.formatUseToolResult(results);
    } catch (error) {
      return {
        success: false,
        error: `Error executing tools: ${getErrorMessage(error)}`
      };
    }
  }

  private async executeSerial(
    batchId: string,
    context: ToolContext,
    calls: ToolCallParams[],
    observer?: ToolBatchExecutionObserver
  ): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = [];

    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const result = await this.executeSingleCall(batchId, context, call, index, calls.length, 'serial', observer);
      results.push(result);

      if (!result.success && !call.continueOnFailure) {
        break;
      }
    }

    return results;
  }

  private async executeParallel(
    batchId: string,
    context: ToolContext,
    calls: ToolCallParams[],
    observer?: ToolBatchExecutionObserver
  ): Promise<ToolCallResult[]> {
    return Promise.all(
      calls.map((call, index) =>
        this.executeSingleCall(batchId, context, call, index, calls.length, 'parallel', observer)
      )
    );
  }

  private async executeSingleCall(
    batchId: string,
    context: ToolContext,
    call: ToolCallParams,
    callIndex: number,
    totalCalls: number,
    strategy: 'serial' | 'parallel',
    observer?: ToolBatchExecutionObserver
  ): Promise<ToolCallResult> {
    const stepId = this.createStepId(batchId, callIndex);
    const stepEvent: ToolBatchStepEvent = {
      batchId,
      stepId,
      callIndex,
      totalCalls,
      context,
      strategy,
      call
    };

    observer?.onStepStarted?.(stepEvent);

    try {
      const result = await this.executeCall(context, call);
      observer?.onStepCompleted?.({
        ...stepEvent,
        result
      });
      return result;
    } catch (error) {
      const result: ToolCallResult = {
        agent: call.agent || 'unknown',
        tool: call.tool || 'unknown',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };

      observer?.onStepCompleted?.({
        ...stepEvent,
        result
      });
      return result;
    }
  }

  private validateContext(context: ToolContext): string[] {
    const errors: string[] = [];

    if (!context) {
      errors.push('context is required. Structure: { workspaceId, sessionId, memory, goal }');
      return errors;
    }

    if (!context.workspaceId || typeof context.workspaceId !== 'string') {
      errors.push('context.workspaceId is required (use "default" for global workspace)');
    }

    if (!context.sessionId || typeof context.sessionId !== 'string') {
      errors.push('context.sessionId is required (any descriptive name, e.g. "blog_writing_session")');
    }

    if (!context.memory || typeof context.memory !== 'string') {
      errors.push('context.memory is required (1-3 sentences: what has happened in this conversation so far)');
    }

    if (!context.goal || typeof context.goal !== 'string') {
      errors.push('context.goal is required (1-3 sentences: what you are trying to accomplish right now)');
    }

    if (context.constraints !== undefined && context.constraints !== null && typeof context.constraints !== 'string') {
      errors.push('context.constraints must be a string if provided');
    }

    return errors;
  }

  private async validateWorkspaceId(workspaceId: string): Promise<string | null> {
    if (workspaceId === 'default') {
      return null;
    }

    const byName = this.knownWorkspaces.find(workspace =>
      workspace.name?.toLowerCase() === workspaceId.toLowerCase()
    );
    if (byName) {
      return null;
    }

    try {
      const plugin = getNexusPlugin(this.app);
      if (!plugin) {
        return null;
      }

      const workspaceService = (plugin as { workspaceService?: WorkspaceService }).workspaceService;
      if (!workspaceService) {
        return null;
      }

      const workspaces = await workspaceService.listWorkspaces();
      const byUuid = workspaces.find(workspace => workspace.id === workspaceId);
      if (byUuid) {
        return null;
      }

      const availableNames = this.knownWorkspaces.length > 0
        ? this.knownWorkspaces.map(workspace => `"${workspace.name}"`).join(', ')
        : '(none created yet)';
      return `Invalid workspace "${workspaceId}". Available: "default" (global), ${availableNames}`;
    } catch {
      return null;
    }
  }

  private async executeCall(context: ToolContext, call: ToolCallParams): Promise<ToolCallResult> {
    const { agent: agentName, tool: toolSlug } = call;

    const callWithAny = call as ToolCallParams & { parameters?: Record<string, unknown> };
    const params = call.params || callWithAny.parameters || {};

    if (!agentName) {
      const availableAgents = Array.from(this.agentRegistry.keys()).join(', ');
      return {
        agent: agentName || 'unknown',
        tool: toolSlug || 'unknown',
        success: false,
        error: `"agent" is required in each call. Available agents: ${availableAgents}`
      };
    }

    if (!toolSlug) {
      return {
        agent: agentName,
        tool: 'unknown',
        success: false,
        error: `"tool" is required in each call. Use getTools({ request: { "${agentName}": [] } }) to see available tools for ${agentName}.`
      };
    }

    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      const availableAgents = Array.from(this.agentRegistry.keys()).join(', ');
      return {
        agent: agentName,
        tool: toolSlug,
        success: false,
        error: `Agent "${agentName}" not found. Available agents: ${availableAgents}. Use getTools({ request: { "agentName": [] } }) to see an agent's tools.`
      };
    }

    const toolInstance = agent.getTool(toolSlug);
    if (!toolInstance) {
      const availableTools = agent.getTools().map(tool => tool.slug).join(', ');
      return {
        agent: agentName,
        tool: toolSlug,
        success: false,
        error: `Tool "${toolSlug}" not found in agent "${agentName}". Available tools: ${availableTools}`
      };
    }

    try {
      const toolResult = await toolInstance.execute(params || {}) as CommonResult;

      const result: ToolCallResult = {
        agent: agentName,
        tool: toolSlug,
        success: toolResult.success
      };

      if (!toolResult.success && toolResult.error) {
        result.error = toolResult.error;
      }

      if (toolResult.success) {
        const toolResultPayload = {
          ...(toolResult as unknown as Record<string, unknown>)
        };
        delete toolResultPayload.success;
        delete toolResultPayload.error;
        delete toolResultPayload.workspaceContext;
        delete toolResultPayload.context;
        delete toolResultPayload.sessionId;

        const { data, ...extra } = toolResultPayload;

        if (data !== undefined && data !== null) {
          result.data = data;
        } else if (Object.keys(extra).length > 0) {
          result.data = extra;
        }
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

  private formatUseToolResult(results: ToolCallResult[]): UseToolResult {
    const allSucceeded = results.every(result => result.success);

    const formatResult = (result: ToolCallResult): Record<string, unknown> => {
      if (result.success) {
        if (result.data !== undefined && typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)) {
          return { success: true, ...(result.data as Record<string, unknown>) };
        }

        if (result.data !== undefined) {
          return { success: true, data: result.data };
        }

        return { success: true };
      }

      return { success: false, error: result.error || 'Unknown error' };
    };

    if (results.length === 1) {
      return formatResult(results[0]) as unknown as UseToolResult;
    }

    const formattedResults = results.map(formatResult);
    const failCount = results.filter(result => !result.success).length;

    return {
      success: allSucceeded,
      ...(allSucceeded ? {} : { error: `${failCount} of ${results.length} failed` }),
      data: { results: formattedResults }
    };
  }

  private createBatchId(): string {
    return `useTools_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private createStepId(batchId: string, callIndex: number): string {
    return `${batchId}_${callIndex}`;
  }
}
