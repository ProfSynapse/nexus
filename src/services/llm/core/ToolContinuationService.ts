/**
 * ToolContinuationService - Tool execution and pingpong loop management
 *
 * Handles the complete tool execution lifecycle:
 * - Initial tool call execution via MCP
 * - Building tool results for continuation
 * - Recursive tool call handling (pingpong pattern)
 * - Tool iteration limits and safety guards
 */

import { BaseAdapter } from '../adapters/BaseAdapter';
import { ConversationContextBuilder } from '../../chat/ConversationContextBuilder';
import { MCPToolExecution, IToolExecutor, ToolResult } from '../adapters/shared/ToolExecutionUtils';
import { ProviderHttpError } from '../adapters/shared/ProviderHttpClient';
import { SupportedProvider, ToolCall as AdapterToolCall, GenerateOptions, LLMProviderError } from '../adapters/types';
import { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';
import { checkForTerminalTool } from './TerminalToolHandler';
import {
  ProviderMessageBuilder,
  ConversationMessage,
  GenerateOptionsInternal,
  StreamingOptions
} from './ProviderMessageBuilder';
import type { ChatRuntimeEvent } from '../runtime/ChatRuntimeEvent';
import { mapProviderStreamChunk } from '../runtime/ProviderStreamEventMapper';

// Union type for tool calls from different sources
type ToolCallUnion = AdapterToolCall | ChatToolCall;

export type StreamYield = ChatRuntimeEvent;

export class ToolContinuationService {
  // Safety limit for recursive tool calls
  private readonly TOOL_ITERATION_LIMIT = 15;

  constructor(
    private toolExecutor: IToolExecutor | undefined,
    private messageBuilder: ProviderMessageBuilder
  ) {}

  private persistLatestResponseId(
    provider: string,
    chunk: { metadata?: Record<string, unknown> },
    options?: StreamingOptions
  ): void {
    if (provider !== 'openai' && provider !== 'openai-codex') {
      return;
    }

    const rawResponseId = chunk.metadata?.responseId;
    if (typeof rawResponseId !== 'string' || !rawResponseId) {
      return;
    }

    this.messageBuilder.updateResponseId(options?.conversationId, rawResponseId);

    if (options) {
      options.responsesApiId = rawResponseId;
    }

    if (options?.onResponsesApiId) {
      options.onResponsesApiId(rawResponseId);
    }
  }

  /**
   * Execute tools and build continuation stream (pingpong)
   */
  async* executeToolsAndContinue(
    adapter: BaseAdapter,
    provider: string,
    detectedToolCalls: ChatToolCall[],
    previousMessages: ConversationMessage[],
    userPrompt: string,
    generateOptions: GenerateOptionsInternal,
    options: StreamingOptions | undefined
  ): AsyncGenerator<StreamYield, void, unknown> {
    let completeToolCallsWithResults: ChatToolCall[] = [];

    try {
      for (const toolCall of detectedToolCalls) {
        yield {
          type: 'tool.execution.started',
          operationId: toolCall.id,
          call: toolCall,
        };
      }

      // Step 1: Execute tools via MCP to get results
      const mcpToolCalls = detectedToolCalls.map((tc) => ({
        id: tc.id,
        function: {
          name: tc.function?.name || tc.name || '',
          arguments: tc.function?.arguments || JSON.stringify(tc.parameters || {})
        }
      }));

      const toolResults = await MCPToolExecution.executeToolCalls(
        this.toolExecutor,
        mcpToolCalls,
        provider as SupportedProvider,
        generateOptions.onToolEvent,
        {
          sessionId: options?.sessionId,
          workspaceId: options?.workspaceId,
          imageProvider: options?.imageProvider,
          imageModel: options?.imageModel,
          transcriptionProvider: options?.transcriptionProvider,
          transcriptionModel: options?.transcriptionModel,
          operationOrigin: options?.operationOrigin,
          operationScopeId: options?.operationScopeId,
          operationSequence: 0,
          conversationId: options?.conversationId,
          messageId: options?.messageId,
          turnId: options?.turnId,
        }
      );

      // Small delay to allow file system operations to complete (prevents race conditions)
      await new Promise(resolve => window.setTimeout(resolve, 100));

      // Build complete tool calls with execution results
	      completeToolCallsWithResults = detectedToolCalls.map(originalCall => {
	        const result = toolResults.find(r => r.id === originalCall.id);
	        return {
	          id: originalCall.id,
	          type: originalCall.type || 'function',
	          name: originalCall.function?.name || originalCall.name,
	          parameters: this.parseToolArguments(originalCall.function?.arguments),
	          result: result?.result,
	          success: result?.success || false,
	          error: result?.error,
	          executionTime: result?.executionTime,
	          function: originalCall.function
        };
	      });

      for (const toolCall of completeToolCallsWithResults) {
        yield {
          type: 'tool.execution.completed',
          operationId: toolCall.id,
          call: toolCall,
          success: toolCall.success === true,
        };
      }

      // Step 1.5: Check for terminal tools (like subagent) that should stop the pingpong loop
      const terminalToolResult = checkForTerminalTool(completeToolCallsWithResults);
      if (terminalToolResult) {
        yield { type: 'assistant.delta', text: terminalToolResult.message };
        yield { type: 'tool.snapshot', calls: completeToolCallsWithResults, ready: false };
        yield { type: 'turn.completed' };
        return;
      }

      // Step 2: Build continuation for pingpong pattern
      const continuationOptions = this.messageBuilder.buildContinuationOptions(
        provider,
        userPrompt,
        detectedToolCalls,
        toolResults,
        previousMessages,
        generateOptions,
        options
      );

      const updatedPreviousMessages = this.updatePreviousMessagesWithToolExecution(
        provider,
        previousMessages,
        detectedToolCalls,
        toolResults
      );

      // Step 3: Start NEW stream with continuation (pingpong)
      yield { type: 'assistant.delta', text: '\n\n' };
      let responseCompleted = false;

      for await (const chunk of adapter.generateStreamAsync('', continuationOptions as unknown as GenerateOptions)) {
        for (const event of mapProviderStreamChunk(chunk)) {
          yield event;
        }

        // Handle recursive tool calls (another pingpong iteration)
        if (chunk.toolCalls) {
          const chatToolCalls: ChatToolCall[] = chunk.toolCalls.map(tc => ({
            ...tc,
            type: tc.type || 'function',
            function: tc.function || { name: '', arguments: '{}' }
          }));

          if (!chunk.complete) {
            continue;
          }

          // Persist the latest OpenAI/Codex response ID BEFORE recursing so the
          // next function_call_output continuation is attached to the response
          // that actually produced these tool calls.
          this.persistLatestResponseId(provider, chunk, options);

          // Execute recursive tool calls
          yield* this.handleRecursiveToolCalls(
            adapter,
            provider,
            chatToolCalls,
            updatedPreviousMessages,
            userPrompt,
            generateOptions,
            options,
            completeToolCallsWithResults,
            1
          );
        }

        if (chunk.complete) {
          responseCompleted = true;
          this.persistLatestResponseId(provider, chunk, options);
          break;
        }
      }

      if (!responseCompleted) {
        throw new Error(`Provider '${provider}' ended a tool continuation without a response boundary.`);
      }

    } catch (toolError) {
      console.error('Streaming tool execution error:', {
        error: toolError,
        message: toolError instanceof Error ? toolError.message : String(toolError),
        stack: toolError instanceof Error ? toolError.stack : undefined,
        // Surface provider error response body for debugging (e.g., OpenRouter 500s)
        ...(toolError instanceof LLMProviderError && toolError.originalError instanceof ProviderHttpError && {
          status: toolError.originalError.response.status,
          responseBody: toolError.originalError.response.text,
          responseJson: toolError.originalError.response.json
        })
      });

      yield {
        type: 'assistant.delta',
        text: `\n\n❌ Tool execution failed: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
      };
      yield {
        type: 'turn.failed',
        error: {
          message: toolError instanceof Error ? toolError.message : String(toolError),
          provider,
        },
      };
      return;
    }

    if (completeToolCallsWithResults.length > 0) {
      yield { type: 'tool.snapshot', calls: completeToolCallsWithResults, ready: false };
    }
    yield { type: 'turn.completed' };
  }

  /**
   * Handle recursive tool calls within continuation stream
   */
  private async* handleRecursiveToolCalls(
    adapter: BaseAdapter,
    provider: string,
    recursiveToolCalls: ChatToolCall[],
    previousMessages: ConversationMessage[],
    userPrompt: string,
    generateOptions: GenerateOptionsInternal,
    options: StreamingOptions | undefined,
    completeToolCallsWithResults: ChatToolCall[],
    operationSequence: number
  ): AsyncGenerator<StreamYield, void, unknown> {
    // Sequence zero is the initial tool response. Refuse sequence 15 before
    // dispatch so at most 15 tool-bearing provider responses can execute.
    if (operationSequence >= this.TOOL_ITERATION_LIMIT) {
      yield* this.yieldToolLimitMessage();
      return;
    }

    for (const toolCall of recursiveToolCalls) {
      yield {
        type: 'tool.execution.started',
        operationId: toolCall.id,
        call: toolCall,
      };
    }

    const recursiveMcpToolCalls = recursiveToolCalls.map((tc) => {
      let argumentsStr = '';

      if (tc.function?.arguments) {
        argumentsStr = tc.function.arguments;
      } else if (tc.parameters) {
        argumentsStr = JSON.stringify(tc.parameters);
      } else {
        argumentsStr = '{}';
      }

      return {
        id: tc.id,
        function: {
          name: tc.function?.name || tc.name || '',
          arguments: argumentsStr
        }
      };
    });

    const recursiveToolResults = await MCPToolExecution.executeToolCalls(
      this.toolExecutor,
      recursiveMcpToolCalls,
      provider as SupportedProvider,
      generateOptions.onToolEvent,
      {
        sessionId: options?.sessionId,
        workspaceId: options?.workspaceId,
        imageProvider: options?.imageProvider,
        imageModel: options?.imageModel,
        transcriptionProvider: options?.transcriptionProvider,
        transcriptionModel: options?.transcriptionModel,
        operationOrigin: options?.operationOrigin,
        operationScopeId: options?.operationScopeId,
        operationSequence,
        conversationId: options?.conversationId,
        messageId: options?.messageId,
        turnId: options?.turnId,
      }
    );

    await new Promise(resolve => window.setTimeout(resolve, 100));

    const recursiveCompleteToolCalls: ChatToolCall[] = recursiveToolCalls.map((tc, index) => ({
      ...tc,
      result: recursiveToolResults[index]?.result,
      success: recursiveToolResults[index]?.success || false,
      error: recursiveToolResults[index]?.error,
      executionTime: recursiveToolResults[index]?.executionTime
    }));

    completeToolCallsWithResults.push(...recursiveCompleteToolCalls);

    for (const toolCall of recursiveCompleteToolCalls) {
      yield {
        type: 'tool.execution.completed',
        operationId: toolCall.id,
        call: toolCall,
        success: toolCall.success === true,
      };
    }

    const terminalToolResult = checkForTerminalTool(recursiveCompleteToolCalls);
    if (terminalToolResult) {
      yield { type: 'assistant.delta', text: terminalToolResult.message };
      yield { type: 'tool.snapshot', calls: completeToolCallsWithResults, ready: false };
      return;
    }

    const recursiveContinuationOptions = this.messageBuilder.buildContinuationOptions(
      provider,
      userPrompt,
      recursiveToolCalls,
      recursiveToolResults,
      previousMessages,
      generateOptions,
      options
    );

    const updatedPreviousMessages = this.updatePreviousMessagesWithToolExecution(
      provider,
      previousMessages,
      recursiveToolCalls,
      recursiveToolResults
    );

    yield { type: 'assistant.delta', text: '\n\n' };
    let recursiveToolCallsDetected: ChatToolCall[] = [];
    let responseCompleted = false;

    for await (const recursiveChunk of adapter.generateStreamAsync('', recursiveContinuationOptions as unknown as GenerateOptions)) {
      for (const event of mapProviderStreamChunk(recursiveChunk)) {
        yield event;
      }

      if (recursiveChunk.toolCalls) {
        const nestedChatToolCalls: ChatToolCall[] = recursiveChunk.toolCalls.map(tc => ({
          ...tc,
          type: tc.type || 'function',
          function: tc.function || { name: '', arguments: '{}' }
        }));

        if (recursiveChunk.complete) {
          recursiveToolCallsDetected = nestedChatToolCalls;
        }
      }

      if (recursiveChunk.complete) {
        responseCompleted = true;
        this.persistLatestResponseId(provider, recursiveChunk, options);
        break;
      }
    }

    if (!responseCompleted) {
      throw new Error(`Provider '${provider}' ended a recursive tool continuation without a response boundary.`);
    }

    if (recursiveToolCallsDetected.length > 0) {
      yield* this.handleRecursiveToolCalls(
        adapter,
        provider,
        recursiveToolCallsDetected,
        updatedPreviousMessages,
        userPrompt,
        generateOptions,
        options,
        completeToolCallsWithResults,
        operationSequence + 1
      );
    }
  }

  private parseToolArguments(argumentsJson: string | undefined): Record<string, unknown> {
    if (!argumentsJson) {
      return {};
    }

    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  }

  /**
   * Update previousMessages with the current tool execution
   */
  private updatePreviousMessagesWithToolExecution(
    provider: string,
    previousMessages: ConversationMessage[],
    toolCalls: ToolCallUnion[],
    toolResults: ToolResult[]
  ): ConversationMessage[] {
    const updatedMessages = ConversationContextBuilder.appendToolExecution(
      provider === 'anthropic' ? 'anthropic' :
      provider === 'google' ? 'google' :
      provider,
      toolCalls,
      toolResults,
      previousMessages
    );

    return updatedMessages as ConversationMessage[];
  }

  /**
   * Yield tool iteration limit message
   */
  private async* yieldToolLimitMessage(): AsyncGenerator<StreamYield, void, unknown> {
    await Promise.resolve();
    const limitMessage = `\n\nTOOL_LIMIT_REACHED: You have used ${this.TOOL_ITERATION_LIMIT} tool iterations. You must now ask the user if they want to continue with more tool calls. Explain what you've accomplished so far and what you still need to do.`;
    yield { type: 'assistant.delta', text: limitMessage };
  }
}
