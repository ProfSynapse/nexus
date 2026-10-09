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
  // Number of individual tool calls allowed before asking the user to continue.
  private readonly TOOL_CALL_LIMIT = 25;

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
    const completeToolCallsWithResults: ChatToolCall[] = [];

    try {
      const toolResults = yield* this.executeToolBatch(
        provider, detectedToolCalls, generateOptions, options, completeToolCallsWithResults, 0
      );
      if (!toolResults) {
        yield { type: 'tool.snapshot', calls: completeToolCallsWithResults, ready: false, replace: true };
        yield { type: 'turn.completed' };
        return;
      }

      // Step 1.5: Check for terminal tools (like subagent) that should stop the pingpong loop
      const terminalToolResult = checkForTerminalTool(completeToolCallsWithResults);
      if (terminalToolResult) {
        yield { type: 'assistant.delta', text: terminalToolResult.message };
        yield { type: 'tool.snapshot', calls: completeToolCallsWithResults, ready: false, replace: true };
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
        toolResults,
        generateOptions.model
      );

      // Step 3: Start NEW stream with continuation (pingpong)
      yield { type: 'assistant.delta', text: '\n\n' };
      let responseCompleted = false;
      let assistantResponseText = '';

      for await (const chunk of adapter.generateStreamAsync('', continuationOptions as unknown as GenerateOptions)) {
        assistantResponseText += chunk.content;
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
            { ...continuationOptions, assistantResponseText },
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
      if ((toolError instanceof Error || toolError instanceof DOMException) && toolError.name === 'AbortError') {
        yield { type: 'tool.snapshot', calls: completeToolCallsWithResults, ready: false, replace: true };
        yield { type: 'turn.aborted', reason: toolError.message };
        return;
      }
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
      yield { type: 'tool.snapshot', calls: completeToolCallsWithResults, ready: false, replace: true };
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
    const batchStart = completeToolCallsWithResults.length;
    const recursiveToolResults = yield* this.executeToolBatch(
      provider, recursiveToolCalls, generateOptions, options, completeToolCallsWithResults, operationSequence
    );
    if (!recursiveToolResults) return;
    const recursiveCompleteToolCalls = completeToolCallsWithResults.slice(batchStart);

    const terminalToolResult = checkForTerminalTool(recursiveCompleteToolCalls);
    if (terminalToolResult) {
      yield { type: 'assistant.delta', text: terminalToolResult.message };
      yield { type: 'tool.snapshot', calls: completeToolCallsWithResults, ready: false, replace: true };
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
      recursiveToolResults,
      generateOptions.model
    );

    yield { type: 'assistant.delta', text: '\n\n' };
    let recursiveToolCallsDetected: ChatToolCall[] = [];
    let responseCompleted = false;
    let assistantResponseText = '';

    for await (const recursiveChunk of adapter.generateStreamAsync('', recursiveContinuationOptions as unknown as GenerateOptions)) {
      assistantResponseText += recursiveChunk.content;
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
        { ...recursiveContinuationOptions, assistantResponseText },
        options,
        completeToolCallsWithResults,
        operationSequence + 1
      );
    }
  }

  /** Execute only the approved part of a batch, retaining remaining calls while paused. */
  private async* executeToolBatch(
    provider: string,
    calls: ChatToolCall[],
    generateOptions: GenerateOptionsInternal,
    options: StreamingOptions | undefined,
    completedCalls: ChatToolCall[],
    operationSequence: number
  ): AsyncGenerator<StreamYield, ToolResult[] | undefined, unknown> {
    const results: ToolResult[] = [];
    let offset = 0;
    while (offset < calls.length) {
      if (options?.abortSignal?.aborted) {
        throw new DOMException('Generation aborted by user', 'AbortError');
      }
      if (completedCalls.length > 0 && completedCalls.length % this.TOOL_CALL_LIMIT === 0) {
        if (!options?.onToolLimitReached) {
          yield* this.yieldToolLimitMessage();
          return undefined;
        }
        if (!await this.requestToolContinuation(completedCalls.length, options) || options.abortSignal?.aborted) {
          throw new DOMException('Stopped by user', 'AbortError');
        }
      }

      const remainingAllowance = this.TOOL_CALL_LIMIT - completedCalls.length % this.TOOL_CALL_LIMIT;
      const batch = calls.slice(offset, offset + remainingAllowance);
      const batchStart = completedCalls.length;
      for (const call of batch) {
        yield { type: 'tool.execution.started', operationId: call.id, call };
      }
      const batchResults = await MCPToolExecution.executeToolCalls(
        this.toolExecutor,
        batch.map(call => ({
          id: call.id,
          function: {
            name: call.function?.name || call.name || '',
            arguments: call.function?.arguments || JSON.stringify(call.parameters || {}),
          },
        })),
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
      results.push(...batchResults);
      for (const call of batch) {
        const result = batchResults.find(candidate => candidate.id === call.id);
        const completed: ChatToolCall = {
          ...call,
          type: call.type || 'function',
          name: call.function?.name || call.name,
          parameters: call.parameters || this.parseToolArguments(call.function?.arguments),
          result: result?.result,
          success: result?.success || false,
          error: result?.error,
          executionTime: result?.executionTime,
        };
        completedCalls.push(completed);
        yield { type: 'tool.execution.completed', operationId: completed.id, call: completed, success: completed.success === true };
      }
      offset += batch.length;
      // A terminal result ends the parent turn before another slice or prompt.
      if (checkForTerminalTool(completedCalls.slice(batchStart))) return results;
      // Allow file operations to settle before the next provider continuation.
      await new Promise(resolve => window.setTimeout(resolve, 100));
    }
    return results;
  }

  private parseToolArguments(argumentsJson: string | undefined): Record<string, unknown> {
    if (!argumentsJson) {
      return {};
    }

    try {
      const parsed = JSON.parse(argumentsJson) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      // The executor already rejected this call. Keep its error and raw
      // function.arguments so the model can correct it in the continuation.
      return {};
    }
  }

  private async requestToolContinuation(completedIterations: number, options: StreamingOptions): Promise<boolean> {
    const signal = options.abortSignal;
    if (signal?.aborted) return false;

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<boolean>(resolve => {
      onAbort = () => resolve(false);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        options.onToolLimitReached?.(completedIterations, signal) ?? Promise.resolve(false),
        aborted,
      ]);
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Update previousMessages with the current tool execution
   */
  private updatePreviousMessagesWithToolExecution(
    provider: string,
    previousMessages: ConversationMessage[],
    toolCalls: ToolCallUnion[],
    toolResults: ToolResult[],
    model?: string
  ): ConversationMessage[] {
    const updatedMessages = ConversationContextBuilder.appendToolExecution(
      provider === 'anthropic' ? 'anthropic' :
      provider === 'google' ? 'google' :
      provider,
      toolCalls,
      toolResults,
      previousMessages,
      model
    );

    return updatedMessages as ConversationMessage[];
  }

  /**
   * Yield tool iteration limit message
   */
  private async* yieldToolLimitMessage(): AsyncGenerator<StreamYield, void, unknown> {
    await Promise.resolve();
    const limitMessage = `\n\nI've paused after ${this.TOOL_CALL_LIMIT} tool calls. Your progress is saved. Send a message when you'd like me to keep going.`;
    yield { type: 'assistant.delta', text: limitMessage };
  }
}
