/**
 * StreamingOrchestrator - Manages streaming LLM responses with tool execution
 *
 * Orchestrates the complete streaming lifecycle by coordinating:
 * - ProviderMessageBuilder: Provider-specific message formatting
 * - ToolContinuationService: Tool execution and pingpong loop
 * - TerminalToolHandler: Detection of tools that stop the loop
 *
 * Follows Single Responsibility Principle - only handles stream coordination.
 */

import { IToolExecutor } from '../adapters/shared/ToolExecutionUtils';
import { LLMProviderSettings } from '../../../types';
import { IAdapterRegistry } from './AdapterRegistry';
import { LLMProviderError, GenerateOptions } from '../adapters/types';
import { Notice } from 'obsidian';
import { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';
import {
  ProviderMessageBuilder,
  ConversationMessage,
  GenerateOptionsInternal,
  StreamingOptions,
  GoogleMessage
} from './ProviderMessageBuilder';
import { ToolContinuationService, StreamYield } from './ToolContinuationService';
import type { BaseAdapter } from '../adapters/BaseAdapter';
import type { ChatRuntimeEvent } from '../runtime/ChatRuntimeEvent';
import { mapProviderStreamChunk } from '../runtime/ProviderStreamEventMapper';

// Re-export types for backward compatibility
export type { ConversationMessage, GoogleMessage, StreamingOptions, StreamYield };

export class StreamingOrchestrator {
  // Track OpenAI response IDs for stateful continuations
  private conversationResponseIds: Map<string, string> = new Map();

  // Delegate services
  private messageBuilder: ProviderMessageBuilder;
  private toolContinuation: ToolContinuationService;

  constructor(
    private adapterRegistry: IAdapterRegistry,
    private settings: LLMProviderSettings,
    toolExecutor?: IToolExecutor
  ) {
    this.messageBuilder = new ProviderMessageBuilder(this.conversationResponseIds);
    this.toolContinuation = new ToolContinuationService(toolExecutor, this.messageBuilder);
  }

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

    const existingId = options?.conversationId
      ? this.conversationResponseIds.get(options.conversationId)
      : undefined;

    this.messageBuilder.updateResponseId(options?.conversationId, rawResponseId);

    if (options) {
      options.responsesApiId = rawResponseId;
    }

    if (options?.onResponsesApiId && existingId !== rawResponseId) {
      options.onResponsesApiId(rawResponseId);
    }
  }

  private createAdapterGenerateOptions(options: GenerateOptionsInternal): GenerateOptions {
    return {
      ...options,
      conversationHistory: options.conversationHistory as Array<Record<string, unknown>> | undefined
    };
  }

  private async* forwardProviderStream(
    adapter: BaseAdapter,
    provider: string,
    prompt: string,
    generateOptions: GenerateOptions,
    options: StreamingOptions | undefined,
    state: { detectedToolCalls: ChatToolCall[] }
  ): AsyncGenerator<ChatRuntimeEvent, void, unknown> {
    for await (const chunk of adapter.generateStreamAsync(prompt, generateOptions)) {
      if (chunk.toolCalls && chunk.complete) {
        state.detectedToolCalls = chunk.toolCalls.map(toolCall => ({
          ...toolCall,
          type: 'function',
          function: toolCall.function || { name: '', arguments: '{}' },
        }));
      }

      for (const event of mapProviderStreamChunk(chunk)) {
        yield event;
      }

      if (chunk.complete) {
        this.persistLatestResponseId(provider, chunk, options);
        return;
      }
    }

    throw new Error(`Provider '${provider}' ended its stream without a response.completed event.`);
  }

  /**
   * Primary method: orchestrate streaming response with tool execution
   * @param messages - Conversation message history
   * @param options - Streaming configuration
   * @returns AsyncGenerator yielding chunks and tool calls
   */
  async* generateResponseStream(
    messages: ConversationMessage[],
    options?: StreamingOptions
  ): AsyncGenerator<StreamYield, void, unknown> {
    // Validate settings
    if (!this.settings || !this.settings.defaultModel) {
      throw new Error('LLM service not properly configured - missing settings');
    }

    // Determine provider and model
    const provider = options?.provider || this.settings.defaultModel.provider;
    const model = options?.model || this.settings.defaultModel.model;

    // Get adapter
    const adapter = this.adapterRegistry.getAdapter(provider);
    if (!adapter) {
      const availableProviders = this.adapterRegistry.getAvailableProviders();
      console.error(`[StreamingOrchestrator] Provider '${provider}' not available. Available providers:`, availableProviders);
      throw new Error(`Provider not available: ${provider}. Available: [${availableProviders.join(', ')}]`);
    }

    // Build initial options via message builder
    const { generateOptions, userPrompt } = this.messageBuilder.buildInitialOptions(
      provider,
      model,
      messages,
      options
    );

    // Store original messages for pingpong context (exclude the last user message)
    const previousMessages = messages.slice(0, -1);

    // Execute initial provider response and detect tool calls. Provider response
    // completion is not turn completion: a tool continuation may follow.
    const streamState: { detectedToolCalls: ChatToolCall[] } = {
      detectedToolCalls: [],
    };

    // For Google, pass empty string as prompt since conversation is in conversationHistory
    const isGoogleModel = provider === 'google';
    const promptToPass = isGoogleModel ? '' : userPrompt;

    // Determine the active adapter and provider for streaming.
    // These may be swapped to a fallback on Codex rate limit (429).
    let activeAdapter = adapter;
    let activeProvider = provider;

    yield { type: 'response.resolved', provider: activeProvider, model };

    try {
      const adapterGenerateOptions = this.createAdapterGenerateOptions(generateOptions);
      yield* this.forwardProviderStream(
        activeAdapter,
        activeProvider,
        promptToPass,
        adapterGenerateOptions,
        options,
        streamState
      );
    } catch (error) {
      // On Codex 429, fall back to standard OpenAI adapter if available
      if (
        error instanceof LLMProviderError &&
        error.code === 'RATE_LIMIT_ERROR' &&
        error.provider === 'openai-codex'
      ) {
        const fallbackAdapter = this.adapterRegistry.getAdapter('openai');
        if (fallbackAdapter) {
          new Notice('Rate limit reached. Falling back to the API.');
          activeAdapter = fallbackAdapter;
          activeProvider = 'openai';

          // Reset streaming state for retry
          streamState.detectedToolCalls = [];

          yield { type: 'response.resolved', provider: activeProvider, model };

          const adapterGenerateOptions = this.createAdapterGenerateOptions(generateOptions);
          yield* this.forwardProviderStream(
            fallbackAdapter,
            activeProvider,
            promptToPass,
            adapterGenerateOptions,
            options,
            streamState
          );
        } else {
          // No fallback available — re-throw original error
          throw error;
        }
      } else {
        throw error;
      }
    }

    const detectedToolCalls = streamState.detectedToolCalls;

    // If no tool calls were requested, the provider response closes the turn.
    if (detectedToolCalls.length === 0 || !generateOptions.tools || generateOptions.tools.length === 0) {
      yield { type: 'turn.completed' };
      return;
    }

    const providerExecutedTools = detectedToolCalls.every((toolCall) =>
      toolCall.providerExecuted ||
      toolCall.result !== undefined ||
      toolCall.success !== undefined ||
      toolCall.error !== undefined
    );

    if (providerExecutedTools) {
      yield { type: 'turn.completed' };
      return;
    }

    // Tool calls detected - delegate to ToolContinuationService. It owns the
    // one terminal turn event for the complete ping-pong lifecycle.
    yield* this.toolContinuation.executeToolsAndContinue(
      activeAdapter,
      activeProvider,
      detectedToolCalls,
      previousMessages,
      userPrompt,
      generateOptions,
      options
    );
  }
}
