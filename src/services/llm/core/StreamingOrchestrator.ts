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
import { TokenUsage } from '../adapters/types';
import { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';
import {
  ProviderMessageBuilder,
  ConversationMessage,
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
    try {
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

      // For Google, pass empty string as prompt since conversation is in conversationHistory
      const isGoogleModel = provider === 'google';
      const promptToPass = isGoogleModel ? '' : userPrompt;

      for await (const chunk of adapter.generateStreamAsync(promptToPass, generateOptions)) {
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
          // Store OpenAI response ID for future continuations
          if (provider === 'openai' && chunk.metadata?.responseId && options?.conversationId) {
            this.conversationResponseIds.set(options.conversationId, chunk.metadata.responseId);
          }
          break;
        }
      }

      // If no tool calls detected, we're done
      if (detectedToolCalls.length === 0 || !generateOptions.tools || generateOptions.tools.length === 0) {
        yield {
          chunk: '',
          complete: true,
          content: fullContent,
          toolCalls: undefined,
          usage: finalUsage
        };
        return;
      }

      // Tool calls detected - delegate to ToolContinuationService
      yield* this.toolContinuation.executeToolsAndContinue(
        adapter,
        provider,
        detectedToolCalls,
        previousMessages,
        userPrompt,
        generateOptions,
        options,
        finalUsage
      );

    } catch (error) {
      throw error;
    }
  }
}
