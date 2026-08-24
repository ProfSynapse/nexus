import { App } from 'obsidian';
import { IAgent } from '../../interfaces/IAgent';
import { CommonResult } from '../../../types';
import { NormalizedUseToolParams, ToolCallParams, ToolCallResult, ToolContext, UseToolResult } from '../types';
import { getErrorMessage } from '../../../utils/errorUtils';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { WorkspaceService } from '../../../services/WorkspaceService';
import { matchWorkspaces } from '../../memoryManager/services/WorkspaceMatcher';
import { toKebabCase } from './ToolCliNormalizer';
import type { ToolExecutionOrigin } from '../../../types/tools/ToolOperationTypes';
import { ToolOperationService } from './ToolOperationService';
import { getRegisteredToolExecutionPolicy } from '../../policy/ToolExecutionPolicyCatalog';

/**
 * The slice of NexusPlugin this service needs. Declared structurally to avoid
 * importing the plugin class (circular) — but unlike an inline cast it names
 * members that actually exist on the class.
 */
interface NexusPluginLike {
  services?: { workspaceService?: WorkspaceService };
  getService?<T>(name: string, timeoutMs?: number): Promise<T | null>;
}

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
  operationId?: string;
  operationOrigin?: ToolExecutionOrigin;
  operationReplayable?: boolean;
  conversationId?: string;
  messageId?: string;
  turnId?: string;
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
    private knownWorkspaces: ToolManagerWorkspaceInfo[] = [],
    private operationService: ToolOperationService = new ToolOperationService()
  ) {}

  async execute(params: NormalizedUseToolParams, options: ToolBatchExecutionOptions = {}): Promise<UseToolResult> {
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
          error: 'No commands were parsed. Call getTools first, then provide one or more CLI-style commands in the top-level "tool" field.'
        };
      }

      const strategy = params.strategy || 'serial';
      if (strategy === 'parallel') {
        const parallelSafetyError = this.validateParallelSafety(params.calls);
        if (parallelSafetyError) {
          return { success: false, error: parallelSafetyError };
        }
      }

      const batchId = options.batchId || this.createBatchId();
      const operationBaseId = options.operationId || batchId;
      const batchStartedEvent: ToolBatchStartedEvent = {
        batchId,
        context: params.context,
        strategy,
        calls: params.calls,
        totalCalls: params.calls.length
      };

      options.observer?.onBatchStarted?.(batchStartedEvent);

      const results = strategy === 'parallel'
        ? await this.executeParallel(batchId, operationBaseId, params.context, params.calls, options)
        : await this.executeSerial(batchId, operationBaseId, params.context, params.calls, options);

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
    operationBaseId: string,
    context: ToolContext,
    calls: ToolCallParams[],
    options: ToolBatchExecutionOptions
  ): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = [];

    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const result = await this.executeSingleCall(batchId, operationBaseId, context, call, index, calls.length, 'serial', options);
      results.push(result);

      if (!result.success && !call.continueOnFailure) {
        break;
      }
    }

    return results;
  }

  private async executeParallel(
    batchId: string,
    operationBaseId: string,
    context: ToolContext,
    calls: ToolCallParams[],
    options: ToolBatchExecutionOptions
  ): Promise<ToolCallResult[]> {
    return Promise.all(
      calls.map((call, index) =>
        this.executeSingleCall(batchId, operationBaseId, context, call, index, calls.length, 'parallel', options)
      )
    );
  }

  private validateParallelSafety(calls: ToolCallParams[]): string | null {
    const incompatible = calls
      .filter(call => {
        if (!call.agent || !call.tool) {
          return true;
        }
        const tool = this.agentRegistry.get(call.agent)?.getTool(call.tool);
        return !tool || !tool.getExecutionPolicy().parallelSafe;
      })
      .map(call => this.formatCommandName(call));

    if (incompatible.length === 0) {
      return null;
    }

    return `Parallel execution rejected because these commands are not parallel-safe: ${incompatible.join(', ')}. Retry the batch with strategy "serial".`;
  }

  private formatCommandName(call: ToolCallParams): string {
    const agent = call.agent ? toKebabCase(call.agent) : 'unknown-agent';
    const tool = call.tool ? toKebabCase(call.tool) : 'unknown-tool';
    return `"${agent} ${tool}"`;
  }

  private async executeSingleCall(
    batchId: string,
    operationBaseId: string,
    context: ToolContext,
    call: ToolCallParams,
    callIndex: number,
    totalCalls: number,
    strategy: 'serial' | 'parallel',
    options: ToolBatchExecutionOptions
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

    options.observer?.onStepStarted?.(stepEvent);

    try {
      const toolInstance = call.agent && call.tool
        ? this.agentRegistry.get(call.agent)?.getTool(call.tool)
        : undefined;
      const executionPolicy = toolInstance
        ? (typeof toolInstance.getExecutionPolicy === 'function'
            ? toolInstance.getExecutionPolicy()
            : getRegisteredToolExecutionPolicy(call.agent, call.tool))
        : null;
      // Read results can contain note bodies and other vault data. They are
      // deliberately excluded from durable operation receipts; only mutations
      // need replay/deduplication protection.
      const result = toolInstance && executionPolicy?.effect !== 'read'
        ? await this.operationService.execute(
            {
              operationId: `${operationBaseId}:${callIndex}`,
              origin: options.operationOrigin ?? 'external-mcp',
              replayable: options.operationReplayable ?? Boolean(options.operationId),
              workspaceId: context.workspaceId,
              sessionId: context.sessionId,
              conversationId: options.conversationId,
              messageId: options.messageId,
              turnId: options.turnId,
              agent: call.agent,
              tool: call.tool,
              params: call.params || {},
              replayPolicy: executionPolicy?.replay
                ?? getRegisteredToolExecutionPolicy(call.agent, call.tool).replay,
            },
            () => this.executeCall(context, call)
          )
        : await this.executeCall(context, call);
      options.observer?.onStepCompleted?.({
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

      options.observer?.onStepCompleted?.({
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
      errors.push('context.sessionId is required. Use the current chat session ID assigned by the runtime; do not generate a new one per tool call.');
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

    // Fast path over the boot-time snapshot, to skip the async lookup below on
    // vaults where SQLite WAS query-ready at registration. It may only ACCEPT:
    // a miss falls through to the live list rather than rejecting, so a stale or
    // empty snapshot can never reject a real workspace. Do not add a rejection
    // here — that asymmetry is what keeps this from being a second source of
    // truth for the guard (#317).
    const byName = this.knownWorkspaces.find(workspace =>
      workspace.name.toLowerCase() === workspaceId.toLowerCase()
    );
    if (byName) {
      return null;
    }

    try {
      const plugin = getNexusPlugin(this.app) as NexusPluginLike | null;
      if (!plugin) {
        return null;
      }

      // NexusPlugin exposes services via the `services` getter and `getService()`
      // — there is no top-level `plugin.workspaceService`. Reading one silently
      // yielded undefined here, so this whole validation branch never fired.
      const workspaceService =
        plugin.services?.workspaceService
        ?? (await plugin.getService?.<WorkspaceService>('workspaceService'))
        ?? null;
      if (!workspaceService) {
        return null;
      }

      // Accept by id OR name off the LIVE list. Checking the name only against
      // `knownWorkspaces` (above) rejected real workspaces on any vault whose
      // boot snapshot was empty, while the message below — already built from
      // the live list — named that same workspace as the closest match. Both
      // halves must read the same list or the guard contradicts itself (#317).
      const workspaces = await workspaceService.listWorkspaces();
      const target = workspaceId.toLowerCase();
      const byIdOrName = workspaces.find(workspace =>
        workspace.id === workspaceId || workspace.name.toLowerCase() === target
      );
      if (byIdOrName) {
        return null;
      }

      // Last resort before rejecting: ask the canonical resolver. The reserved
      // guides workspace is resolvable by either identifier but is deliberately
      // absent from `listWorkspaces()`, so the list alone cannot see it — the
      // gate would reject the one workspace the product intentionally hides.
      // Only the ACCEPT path consults the resolver; the suggestions below stay
      // on the visible list, so a hidden workspace is never advertised back to
      // the caller. Reaching this only on an otherwise-certain rejection also
      // keeps the extra lookup off the common path (#319).
      const resolved = await workspaceService.getWorkspaceByNameOrId?.(workspaceId);
      if (resolved) {
        return null;
      }

      // Name the alternatives off the LIVE list, not `knownWorkspaces` — that
      // snapshot is taken at boot and is empty whenever SQLite was not ready
      // then, which produced "Available: (none created yet)" on vaults that
      // had workspaces all along.
      const active = workspaces.filter(workspace => !workspace.isArchived);
      const availableNames = active.length > 0
        ? active.map(workspace => `"${workspace.name}"`).join(', ')
        : '(none created yet)';

      // A wrong workspaceId is usually a near-miss on a real name, so point at
      // the closest one instead of leaving the caller to guess again.
      const closest = matchWorkspaces(active, workspaceId, { limit: 1 })[0];
      const didYouMean = closest ? ` Closest match: "${closest.workspace.name}".` : '';

      return `Invalid workspace "${workspaceId}".${didYouMean} Use one of these exact values — do not infer a workspace name from the user's wording. Available: "default" (global), ${availableNames}`;
    } catch {
      return null;
    }
  }

  private async executeCall(context: ToolContext, call: ToolCallParams): Promise<ToolCallResult> {
    const { agent: agentName, tool: toolSlug } = call;

    const callWithAny = call as ToolCallParams & { parameters?: Record<string, unknown> };
    const baseParams = call.params || callWithAny.parameters || {};
    const params = this.applyContextDefaults(context, agentName, toolSlug, baseParams);

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
        error: `"tool" is required in each normalized call. Use getTools({ tool: "${agentName.replace(/Manager$/, '').toLowerCase()}" }) to inspect available commands for ${agentName}.`
      };
    }

    const agent = this.agentRegistry.get(agentName);
    if (!agent) {
      const availableAgents = Array.from(this.agentRegistry.keys()).join(', ');
      return {
        agent: agentName,
        tool: toolSlug,
        success: false,
        error: `Agent "${agentName}" not found. Available agents: ${availableAgents}. Use getTools({ tool: "--help" }) to inspect available commands.`
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
        params,
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

        const hasExtra = Object.keys(extra).length > 0;

        if (data !== undefined && data !== null) {
          // Keep sibling fields instead of dropping them. A tool that returns
          // `data` PLUS a top-level field used to lose the latter silently —
          // which is how loadWorkspace's `resolution` note vanished, leaving
          // an auto-resolved near-miss looking like a plain successful load
          // and the caller never learning a different workspace was opened.
          // `data` is spread last so no existing key can change value.
          result.data = hasExtra && typeof data === 'object' && !Array.isArray(data)
            ? { ...extra, ...(data as Record<string, unknown>) }
            : data;
        } else if (hasExtra) {
          result.data = extra;
        }
      }

      return result;
    } catch (error) {
      return {
        agent: agentName,
        tool: toolSlug,
        params,
        success: false,
        error: `Error executing ${agentName}_${toolSlug}: ${getErrorMessage(error)}`
      };
    }
  }

  private applyContextDefaults(
    context: ToolContext,
    agentName: string | undefined,
    toolSlug: string | undefined,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const shouldInjectSessionId =
      !(agentName === 'searchManager' &&
        toolSlug === 'memory' &&
        params.sessionId === undefined &&
        params.sessionName === undefined);
    const defaulted: Record<string, unknown> = {
      ...params,
      workspaceId: params.workspaceId || context.workspaceId,
      ...(shouldInjectSessionId ? { sessionId: params.sessionId || context.sessionId } : {})
    };

    if (agentName === 'promptManager' && toolSlug === 'generateImage') {
      return {
        ...defaulted,
        provider: params.provider || context.imageProvider,
        model: params.model || context.imageModel
      };
    }

    if (agentName === 'ingestManager' && toolSlug === 'run') {
      return {
        ...defaulted,
        transcriptionProvider: params.transcriptionProvider || context.transcriptionProvider,
        transcriptionModel: params.transcriptionModel || context.transcriptionModel
      };
    }

    return defaulted;
  }

  private formatUseToolResult(results: ToolCallResult[]): UseToolResult {
    const allSucceeded = results.every(result => result.success);

    const formatResult = (result: ToolCallResult): Record<string, unknown> => {
      if (result.success) {
        if (result.data !== undefined && typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)) {
          return {
            agent: result.agent,
            tool: result.tool,
            success: true,
            ...(result.data as Record<string, unknown>)
          };
        }

        if (result.data !== undefined) {
          return { agent: result.agent, tool: result.tool, success: true, data: result.data };
        }

        return { agent: result.agent, tool: result.tool, success: true };
      }

      return {
        agent: result.agent,
        tool: result.tool,
        success: false,
        error: result.error || 'Unknown error'
      };
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
