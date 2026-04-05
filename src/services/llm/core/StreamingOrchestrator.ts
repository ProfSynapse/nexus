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
import { TokenUsage, LLMProviderError, GenerateOptions } from '../adapters/types';
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

    // Execute initial stream and detect tool calls
    let fullContent = '';
    let detectedToolCalls: ChatToolCall[] = [];
    let finalUsage: TokenUsage | undefined = undefined;
    let finalMetadata: Record<string, unknown> | undefined = undefined;

    // For Google, pass empty string as prompt since conversation is in conversationHistory
    const isGoogleModel = provider === 'google';
    const promptToPass = isGoogleModel ? '' : userPrompt;

    // Determine the active adapter and provider for streaming.
    // These may be swapped to a fallback on Codex rate limit (429).
    let activeAdapter = adapter;
    let activeProvider = provider;

      try {
        const adapterGenerateOptions = this.createAdapterGenerateOptions(generateOptions);
        for await (const chunk of activeAdapter.generateStreamAsync(promptToPass, adapterGenerateOptions)) {
          // Track usage from chunks
          if (chunk.usage) {
            finalUsage = chunk.usage;
          }

          // Handle text content streaming
          if (chunk.content) {
            fullContent += chunk.content;

            yield {
              chunk: chunk.content,
              complete: false,
              content: fullContent,
              toolCalls: undefined
            };
          }

          // Handle reasoning/thinking content (Claude, GPT-5, Gemini)
          if (chunk.reasoning) {
            yield {
              chunk: '',
              complete: false,
              content: fullContent,
              toolCalls: undefined,
              reasoning: chunk.reasoning,
              reasoningComplete: chunk.reasoningComplete
            };
          }

          // Handle dynamic tool call detection
          if (chunk.toolCalls) {
            const chatToolCalls: ChatToolCall[] = chunk.toolCalls.map(tc => ({
              ...tc,
              type: tc.type || 'function',
              function: tc.function || { name: '', arguments: '{}' }
            }));

            // ALWAYS yield tool calls for progressive UI display
            yield {
              chunk: '',
              complete: false,
              content: fullContent,
              toolCalls: chatToolCalls,
              toolCallsReady: chunk.complete || false
            };

            // Only STORE tool calls for execution when streaming is COMPLETE
            if (chunk.complete) {
              detectedToolCalls = chatToolCalls;
            }
          }

          if (chunk.complete) {
            if (chunk.metadata) finalMetadata = chunk.metadata;
            this.persistLatestResponseId(activeProvider, chunk, options);
            break;
          }
        }
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
          fullContent = '';
          detectedToolCalls = [];
          finalUsage = undefined;
          finalMetadata = undefined;

          const adapterGenerateOptions = this.createAdapterGenerateOptions(generateOptions);
          for await (const chunk of fallbackAdapter.generateStreamAsync(promptToPass, adapterGenerateOptions)) {
            if (chunk.usage) {
              finalUsage = chunk.usage;
            }

            if (chunk.content) {
              fullContent += chunk.content;
              yield {
                chunk: chunk.content,
                complete: false,
                content: fullContent,
                toolCalls: undefined
              };
            }

            if (chunk.reasoning) {
              yield {
                chunk: '',
                complete: false,
                content: fullContent,
                toolCalls: undefined,
                reasoning: chunk.reasoning,
                reasoningComplete: chunk.reasoningComplete
              };
            }

            if (chunk.toolCalls) {
              const chatToolCalls: ChatToolCall[] = chunk.toolCalls.map(tc => ({
                ...tc,
                type: tc.type || 'function',
                function: tc.function || { name: '', arguments: '{}' }
              }));

              yield {
                chunk: '',
                complete: false,
                content: fullContent,
                toolCalls: chatToolCalls,
                toolCallsReady: chunk.complete || false
              };

              if (chunk.complete) {
                detectedToolCalls = chatToolCalls;
              }
            }

            if (chunk.complete) {
              if (chunk.metadata) finalMetadata = chunk.metadata;
              this.persistLatestResponseId(activeProvider, chunk, options);
              break;
            }
          }
        } else {
          // No fallback available — re-throw original error
          throw error;
        }
      } else {
        throw error;
      }
    }

      // If no tool calls detected, we're done
      if (detectedToolCalls.length === 0 || !generateOptions.tools || generateOptions.tools.length === 0) {
        console.warn(`[StreamingOrchestrator] stream complete — ${fullContent.length} chars | tail: "${fullContent.slice(-100)}"`);
        yield {
          chunk: '',
          complete: true,
          content: fullContent,
          toolCalls: undefined,
          usage: finalUsage,
          metadata: finalMetadata
        };
        return;
      }

      const providerExecutedTools = detectedToolCalls.every((toolCall) =>
        toolCall.providerExecuted ||
        toolCall.result !== undefined ||
        toolCall.success !== undefined ||
        toolCall.error !== undefined
      );

      if (providerExecutedTools) {
        yield {
          chunk: '',
          complete: true,
          content: fullContent,
          toolCalls: detectedToolCalls,
          usage: finalUsage,
          metadata: finalMetadata
        };
        return;
      }

      // Tool calls detected - delegate to ToolContinuationService
    yield* this.toolContinuation.executeToolsAndContinue(
        activeAdapter,
        activeProvider,
        detectedToolCalls,
        previousMessages,
        userPrompt,
        generateOptions,
        options,
        finalUsage
      );
  }
}
