/**
 * tests/eval/EvalToolExecutor.ts — Mock IToolExecutor for eval harness.
 *
 * Implements the IToolExecutor interface with configurable per-tool responses
 * and call capture. Injected into StreamingOrchestrator to intercept tool calls
 * during eval runs without touching real agents.
 *
 * Supports the two-tool architecture (getTools/useTools): when the LLM calls
 * getTools, the executor returns domain tool schemas from the provided tool
 * definitions. When the LLM calls useTools, the executor unwraps the inner
 * tool calls and executes them against registered handlers.
 */

import type { IToolExecutor, ToolResult, ToolExecutionContext } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';
import type { ToolCall, Tool } from '../../src/services/llm/adapters/types';
import type { CapturedToolCall, MockToolResponse } from './types';

type ResponseHandler = (args: Record<string, unknown>) => ToolResult;

export class EvalToolExecutor implements IToolExecutor {
  private responseHandlers: Map<string, ResponseHandler> = new Map();
  private capturedCalls: CapturedToolCall[] = [];

  /**
   * Domain tool definitions — set when running in two-tool (meta) mode.
   * Used by the getTools handler to return realistic tool schemas.
   */
  private domainTools: Tool[] = [];

  /**
   * Set the domain tools available for getTools discovery responses.
   * Called by EvalRunner when the scenario uses the two-tool architecture.
   */
  setDomainTools(tools: Tool[]): void {
    this.domainTools = tools;
  }

  /**
   * Register a dynamic handler for a tool name.
   * The handler receives parsed args and returns a ToolResult.
   */
  registerHandler(toolName: string, handler: ResponseHandler): void {
    this.responseHandlers.set(toolName, handler);
  }

  /**
   * Register a static mock response for a tool name.
   */
  registerStaticResponse(toolName: string, response: MockToolResponse): void {
    this.responseHandlers.set(toolName, (_args: Record<string, unknown>) => ({
      id: '', // Will be filled at execution time
      name: toolName,
      success: response.success,
      result: response.result,
      error: response.error,
    }));
  }

  /**
   * Register all mock responses from a scenario turn's mockResponses map.
   * For useTools mock responses, also registers handlers for the inner
   * domain tool names so they are available when useTools unwraps them.
   */
  registerTurnResponses(mockResponses: Record<string, MockToolResponse>): void {
    for (const [toolName, response] of Object.entries(mockResponses)) {
      this.registerStaticResponse(toolName, response);
    }
  }

  /**
   * IToolExecutor implementation — called by ToolContinuationService.
   *
   * Handles three tool types:
   * 1. getTools — returns domain tool schemas matching production format
   * 2. useTools — unwraps inner calls, executes them, captures domain tool names
   * 3. Domain tools — direct execution via registered handlers
   */
  async executeToolCalls(
    toolCalls: ToolCall[],
    _context?: ToolExecutionContext,
    onToolEvent?: (event: 'started' | 'completed', data: unknown) => void
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const tc of toolCalls) {
      const toolName = tc.function?.name || tc.name || 'unknown';
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        // Keep empty args on parse failure
      }

      onToolEvent?.('started', { toolName, id: tc.id });

      if (toolName === 'getTools') {
        // Two-tool architecture: getTools discovery
        const result = this.handleGetTools(tc.id, toolName, args);
        this.capturedCalls.push({ name: toolName, args, id: tc.id });
        results.push(result);
      } else if (toolName === 'useTools') {
        // Two-tool architecture: useTools execution — unwrap inner calls
        const result = this.handleUseTools(tc.id, toolName, args);
        // Capture the outer useTools call
        this.capturedCalls.push({ name: toolName, args, id: tc.id });
        results.push(result);
      } else {
        // Direct domain tool call
        this.capturedCalls.push({ name: toolName, args, id: tc.id });

        const handler = this.responseHandlers.get(toolName);
        if (handler) {
          const result = handler(args);
          result.id = tc.id;
          result.name = toolName;
          results.push(result);
        } else {
          results.push({
            id: tc.id,
            name: toolName,
            success: true,
            result: { message: `Mock response for ${toolName}` },
          });
        }
      }

      onToolEvent?.('completed', { toolName, id: tc.id });
    }

    return results;
  }

  /**
   * Handle getTools calls by returning domain tool schemas.
   *
   * Production getTools returns { success: true, data: { tools: [...] } }
   * where each tool has { agent, tool, description, inputSchema }.
   *
   * parseAndMergeTools in ToolContinuationService checks for the name
   * 'get_tools' (underscore) so it won't auto-merge these. That's fine —
   * in both production and eval, the LLM uses the schemas from the
   * getTools response to construct its useTools call parameters.
   *
   * The mock handler is checked first (for scenario-specific responses),
   * then falls back to generating schemas from domainTools.
   */
  private handleGetTools(
    id: string,
    toolName: string,
    args: Record<string, unknown>
  ): ToolResult {
    // Check for scenario-specific mock response first
    const handler = this.responseHandlers.get(toolName);
    if (handler) {
      const result = handler(args);
      result.id = id;
      result.name = toolName;
      return result;
    }

    // Auto-generate from domain tools
    const requestedAgents = (args.agents as string[] | undefined)
      ?? (args.request as Array<{ agent: string }> | undefined)?.map(r => r.agent)
      ?? [];

    const schemas = this.domainTools
      .filter(tool => {
        if (requestedAgents.length === 0) return true;
        const name = tool.function?.name ?? '';
        return requestedAgents.some(agent => name.startsWith(`${agent}_`));
      })
      .map(tool => ({
        name: tool.function?.name ?? '',
        description: tool.function?.description ?? '',
        inputSchema: tool.function?.parameters ?? { type: 'object', properties: {} },
      }));

    return {
      id,
      name: toolName,
      success: true,
      result: { tools: schemas },
    };
  }

  /**
   * Handle useTools calls by unwrapping inner tool calls and executing them.
   *
   * Production useTools accepts { context: {...}, calls: [{ tool, params }] }
   * and returns results for each inner call.
   *
   * The mock handler is checked first (for scenario-specific responses),
   * then falls back to executing each inner call against registered handlers.
   */
  private handleUseTools(
    id: string,
    toolName: string,
    args: Record<string, unknown>
  ): ToolResult {
    // Check for scenario-specific mock response first
    const handler = this.responseHandlers.get(toolName);
    if (handler) {
      const result = handler(args);
      result.id = id;
      result.name = toolName;
      return result;
    }

    // Unwrap and execute inner calls
    const calls = (args.calls as Array<{ tool: string; params?: Record<string, unknown> }>) ?? [];
    const innerResults: Array<{ tool: string; success: boolean; result?: unknown; error?: string }> = [];

    for (const call of calls) {
      const innerName = call.tool;
      const innerArgs = call.params ?? {};

      // Capture the inner domain tool call for assertions
      this.capturedCalls.push({
        name: innerName,
        args: innerArgs,
        id: `${id}_inner_${innerName}`,
      });

      const innerHandler = this.responseHandlers.get(innerName);
      if (innerHandler) {
        const innerResult = innerHandler(innerArgs);
        innerResults.push({
          tool: innerName,
          success: innerResult.success,
          result: innerResult.result,
          error: innerResult.error,
        });
      } else {
        innerResults.push({
          tool: innerName,
          success: true,
          result: { message: `Mock response for ${innerName}` },
        });
      }
    }

    return {
      id,
      name: toolName,
      success: true,
      result: { results: innerResults },
    };
  }

  /**
   * Get all captured tool calls since last reset.
   */
  getCapturedCalls(): CapturedToolCall[] {
    return [...this.capturedCalls];
  }

  /**
   * Clear all handlers and captured calls.
   */
  reset(): void {
    this.responseHandlers.clear();
    this.capturedCalls = [];
  }

  /**
   * Clear only captured calls (keep handlers).
   */
  resetCalls(): void {
    this.capturedCalls = [];
  }
}
