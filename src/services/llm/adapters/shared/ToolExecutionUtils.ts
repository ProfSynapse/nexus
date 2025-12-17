/**
 * Tool Execution Utilities
 *
 * Clean architecture: Tool execution is decoupled from LLM adapters.
 * Adapters handle LLM communication, this utility handles tool execution.
 *
 * The toolExecutor is passed explicitly - no reaching into adapter internals.
 * This enables tools to work on ALL platforms (desktop + mobile).
 */

import { SupportedProvider } from '../types';

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  id: string;
  name?: string;
  success: boolean;
  result?: any;
  error?: string;
  executionTime?: number;
}

/**
 * Interface for tool executors
 * DirectToolExecutor implements this interface
 */
export interface IToolExecutor {
  executeToolCalls(
    toolCalls: ToolCall[],
    context?: { sessionId?: string; workspaceId?: string },
    onToolEvent?: (event: 'started' | 'completed', data: any) => void
  ): Promise<ToolResult[]>;
}

/**
 * Static utility class for tool execution
 * Decoupled from adapters - receives toolExecutor explicitly
 */
export class ToolExecutionUtils {

  /**
   * Execute tool calls using the provided executor
   * Clean interface - no adapter dependency
   */
  static async executeToolCalls(
    toolExecutor: IToolExecutor | null | undefined,
    toolCalls: ToolCall[],
    provider: SupportedProvider,
    onToolEvent?: (event: 'started' | 'completed', data: any) => void,
    context?: { sessionId?: string; workspaceId?: string }
  ): Promise<ToolResult[]> {
    if (!toolExecutor) {
      return toolCalls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        success: false,
        error: 'Tool execution not available - no executor configured'
      }));
    }

    try {
      return await toolExecutor.executeToolCalls(toolCalls, context, onToolEvent);
    } catch (error) {
      console.error(`[ToolExecutionUtils] Tool execution failed:`, error);
      throw error;
    }
  }

  /**
   * Build tool messages for continuation
   * Formats differently for Anthropic, Google, vs other providers
   */
  static buildToolMessages(
    toolResults: ToolResult[],
    provider: SupportedProvider
  ): Array<any> {
    if (provider === 'anthropic') {
      // Anthropic format: role='user', content array with tool_result objects
      return toolResults.map(result => ({
        role: 'user' as const,
        content: [
          {
            type: 'tool_result',
            tool_use_id: result.id,
            content: result.success
              ? JSON.stringify(result.result)
              : `Error: ${result.error}`
          }
        ]
      }));
    } else if (provider === 'google') {
      // Google Gemini format: role='function', parts array with functionResponse objects
      return toolResults.map(result => ({
        role: 'function' as const,
        parts: [
          {
            functionResponse: {
              name: result.name,
              response: result.success
                ? result.result
                : { error: result.error }
            }
          }
        ]
      }));
    } else {
      // OpenAI format (used by OpenAI, OpenRouter, Groq, Mistral, etc.)
      return toolResults.map(result => ({
        role: 'tool' as const,
        tool_call_id: result.id,
        content: result.success
          ? JSON.stringify(result.result)
          : `Error: ${result.error}`
      }));
    }
  }

  /**
   * Build tool metadata for response
   */
  static buildToolMetadata(toolResults: ToolResult[]) {
    return {
      toolCallCount: toolResults.length,
      toolCalls: toolResults.length > 0 ? toolResults.map(result => ({
        id: result.id,
        name: result.name,
        result: result.result,
        success: result.success,
        error: result.error,
        executionTime: result.executionTime
      })) : undefined
    };
  }
}

// Re-export with old names for backward compatibility during migration
export type { ToolCall as MCPToolCall, ToolResult as MCPToolResult };
export { ToolExecutionUtils as MCPToolExecution };
