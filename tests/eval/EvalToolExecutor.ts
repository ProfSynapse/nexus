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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toKebabCase(value: string): string {
  return value
    .replace(/Manager$/i, '')
    .replace(/Agent$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/--+/g, '-')
    .toLowerCase();
}

function splitTopLevelSegments(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if ((char === '"' || char === '\'') && (!quote || quote === char)) {
      quote = quote === char ? null : char;
      current += char;
      continue;
    }

    if (char === ',' && !quote) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    segments.push(trimmed);
  }

  return segments;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function getSchemaType(schema: Record<string, unknown>): string {
  if (schema.type === 'array') {
    const items = isRecord(schema.items) ? schema.items : {};
    return `array<${typeof items.type === 'string' ? items.type : 'unknown'}>`;
  }
  return typeof schema.type === 'string' ? schema.type : 'unknown';
}

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
   * where each tool has { agent, tool, description, inputSchema }. In both
   * production and eval, the LLM uses those schemas to construct its
   * useTools call parameters — the 2-tool surface never exposes them as
   * individually-callable functions.
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
    const requestedSelectors = typeof args.tool === 'string'
      ? splitTopLevelSegments(args.tool)
      : [];

    const schemas = this.domainTools
      .filter(tool => {
        if (requestedSelectors.length === 0) return true;
        const functionName = tool.function?.name ?? '';
        const [rawAgent, rawTool] = functionName.split('_');
        const agentAlias = toKebabCase(rawAgent);
        const toolAlias = toKebabCase(rawTool ?? '');

        return requestedSelectors.some((selector) => {
          const tokens = tokenize(selector);
          if (tokens.length === 0) return false;
          const expectedAgent = toKebabCase(tokens[0]);
          const expectedTool = tokens[1] ? toKebabCase(tokens[1].replace(/^--/, '')) : undefined;
          if (expectedAgent !== agentAlias) return false;
          return expectedTool ? expectedTool === toolAlias : true;
        });
      })
      .map(tool => this.buildCliSchema(tool));

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
   * Production useTools accepts { tool: "agent tool-name --flag value" }
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
    const calls = this.parseCliCommands(typeof args.tool === 'string' ? args.tool : '');
    const innerResults: Array<{ tool: string; success: boolean; result?: unknown; error?: string }> = [];

    for (const call of calls) {
      const innerName = call.name;
      const innerArgs = call.args ?? {};

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

  private buildCliSchema(tool: Tool): Record<string, unknown> {
    const functionName = tool.function?.name ?? '';
    const [rawAgent, rawTool] = functionName.split('_');
    const command = `${toKebabCase(rawAgent)} ${toKebabCase(rawTool ?? '')}`;
    const schema = isRecord(tool.function?.parameters)
      ? tool.function?.parameters
      : { type: 'object', properties: {} };
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === 'string')
        : [],
    );

    const argumentsSchema = Object.entries(properties).map(([name, rawSchema]) => {
      const property = isRecord(rawSchema) ? rawSchema : {};
      const type = getSchemaType(property);
      const requiredArg = required.has(name);
      const positional = requiredArg && type !== 'boolean' && type !== 'object' && !type.startsWith('array<');
      return {
        name,
        flag: `--${toKebabCase(name)}`,
        type,
        required: requiredArg,
        positional,
        ...(typeof property.description === 'string' ? { description: property.description } : {}),
      };
    });

    const usage = [
      command,
      ...argumentsSchema.map((arg) => {
        if (Boolean(arg.positional)) {
          return `<${String(arg.name)}>`;
        }
        if (String(arg.type) === 'boolean') {
          return Boolean(arg.required) ? String(arg.flag) : `[${String(arg.flag)}]`;
        }
        return Boolean(arg.required)
          ? `${String(arg.flag)} <${String(arg.name)}>`
          : `[${String(arg.flag)} <${String(arg.name)}>]`;
      }),
    ].join(' ');

    return {
      agent: rawAgent,
      tool: rawTool,
      description: tool.function?.description ?? '',
      command,
      usage,
      arguments: argumentsSchema,
      examples: [command],
    };
  }

  private parseCliCommands(commandString: string): Array<{ name: string; args: Record<string, unknown> }> {
    if (!commandString.trim()) {
      return [];
    }

    return splitTopLevelSegments(commandString)
      .map((segment) => tokenize(segment))
      .filter((tokens) => tokens.length >= 2)
      .map((tokens) => {
        const agentAlias = toKebabCase(tokens[0]);
        const toolAlias = toKebabCase(tokens[1].replace(/^--/, ''));
        const tool = this.domainTools.find((candidate) => {
          const [rawAgent, rawTool] = (candidate.function?.name ?? '').split('_');
          return toKebabCase(rawAgent) === agentAlias && toKebabCase(rawTool ?? '') === toolAlias;
        });
        const innerName = tool?.function?.name ?? `${tokens[0]}_${tokens[1]}`;
        return {
          name: innerName,
          args: {},
        };
      });
  }
}
