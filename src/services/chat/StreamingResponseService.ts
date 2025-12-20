/**
 * StreamingResponseService - Manages streaming response generation
 *
 * Responsibilities:
 * - Coordinate LLM streaming with tool execution
 * - Handle progressive tool call detection
 * - Integrate cost tracking during streaming
 * - Persist messages and usage data
 * - Build LLM context with conversation history
 * - Manage streaming lifecycle (start, chunk, complete, abort)
 *
 * This is the core streaming coordination layer that brings together:
 * - ToolCallService (tool detection/events)
 * - CostTrackingService (usage/cost calculation)
 * - LLMService (actual streaming)
 * - ConversationService (persistence)
 *
 * Follows Single Responsibility Principle - only handles streaming coordination.
 */

import { ConversationData } from '../../types/chat/ChatTypes';
import { ConversationContextBuilder } from './ConversationContextBuilder';
import { ToolCallService } from './ToolCallService';
import { CostTrackingService } from './CostTrackingService';
import type { MessageQueueService } from './MessageQueueService';

export interface StreamingOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  messageId?: string;
  abortSignal?: AbortSignal;
  excludeFromMessageId?: string; // Exclude this message and everything after from context (for retry)
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
}

export interface StreamingChunk {
  chunk: string;
  complete: boolean;
  messageId: string;
  toolCalls?: any[];
  // Reasoning/thinking support (Claude, GPT-5, Gemini, etc.)
  reasoning?: string;           // Incremental reasoning text
  reasoningComplete?: boolean;  // True when reasoning finished
  // Token usage (available on complete chunk)
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface StreamingDependencies {
  llmService: any;
  conversationService: any;
  toolCallService: ToolCallService;
  costTrackingService: CostTrackingService;
  messageQueueService?: MessageQueueService; // Optional: for subagent result queueing
}

export class StreamingResponseService {
  private currentProvider?: string;

  constructor(
    private dependencies: StreamingDependencies
  ) {}

  /**
   * Generate streaming response with full coordination
   *
   * Always loads conversation from storage to ensure fresh data with tool calls
   */
  async* generateResponse(
    conversationId: string,
    userMessage: string,
    options?: StreamingOptions
  ): AsyncGenerator<StreamingChunk, void, unknown> {
    // Notify queue service that generation is starting (pauses processing)
    this.dependencies.messageQueueService?.onGenerationStart?.();

    try {
      const messageId = options?.messageId || `msg_${Date.now()}_ai`;
      let accumulatedContent = '';

      // Get defaults from LLMService if user didn't select provider/model
      const defaultModel = this.dependencies.llmService.getDefaultModel();

      // Check if message already exists (retry case)
      const existingConv = await this.dependencies.conversationService.getConversation(conversationId);
      const messageExists = existingConv?.messages.some((m: any) => m.id === messageId);

      // Only create placeholder if message doesn't exist (prevents duplicate during retry)
      if (!messageExists) {
        await this.dependencies.conversationService.addMessage({
          conversationId,
          role: 'assistant',
          content: '', // Will be updated as streaming progresses
          id: messageId
        });
      }

      // Get provider for context building
      const provider = options?.provider || defaultModel.provider;
      this.currentProvider = provider; // Store for context building

      // ALWAYS load conversation from storage to get complete history including tool calls
      const conversation = await this.dependencies.conversationService.getConversation(conversationId);

      // Filter conversation for retry: exclude message being retried and everything after
      let filteredConversation = conversation;
      if (conversation && options?.excludeFromMessageId) {
        const excludeIndex = conversation.messages.findIndex((m: any) => m.id === options.excludeFromMessageId);
        if (excludeIndex >= 0) {
          filteredConversation = {
            ...conversation,
            messages: conversation.messages.slice(0, excludeIndex)
          };
        }
      }

      // Build conversation context for LLM with provider-specific formatting
      // NOTE: buildLLMMessages includes ALL messages from storage, including the user message
      // that was just saved by sendMessage(), so we DON'T add it again here
      const messages = filteredConversation ?
        this.buildLLMMessages(filteredConversation, provider, options?.systemPrompt) : [];

      // Add system prompt if provided and not already added by buildLLMMessages
      if (options?.systemPrompt && !messages.some(m => m.role === 'system')) {
        messages.unshift({ role: 'system', content: options.systemPrompt });
      }

      // Only add user message if it's NOT already in the filtered conversation
      // (happens on first message when conversation is empty, or during retry)
      if (!filteredConversation || !filteredConversation.messages.some((m: any) => m.content === userMessage && m.role === 'user')) {
        messages.push({ role: 'user', content: userMessage });
      }

      // Get tools from ToolCallService in OpenAI format
      const openAITools = this.dependencies.toolCallService.getAvailableTools();

      // Prepare LLM options with converted tools
      const llmOptions: any = {
        provider: options?.provider || defaultModel.provider,
        model: options?.model || defaultModel.model,
        systemPrompt: options?.systemPrompt,
        tools: openAITools,
        toolChoice: openAITools.length > 0 ? 'auto' : undefined,
        abortSignal: options?.abortSignal,
        sessionId: options?.sessionId,
        workspaceId: options?.workspaceId,
        conversationId, // CRITICAL: Required for OpenAI Responses API response ID tracking
        enableThinking: options?.enableThinking,
        thinkingEffort: options?.thinkingEffort
      };

      // Add tool event callback for live UI updates (delegates to ToolCallService)
      llmOptions.onToolEvent = (event: 'started' | 'completed', data: any) => {
        this.dependencies.toolCallService.fireToolEvent(messageId, event, data);
      };

      // Add usage callback for async cost calculation (e.g., OpenRouter streaming)
      llmOptions.onUsageAvailable = this.dependencies.costTrackingService.createUsageCallback(conversationId, messageId);

      // Stream the response from LLM service with MCP tools
      let toolCalls: any[] | undefined = undefined;
      this.dependencies.toolCallService.resetDetectedTools(); // Reset tool detection state for new message

      // Track usage and cost for conversation tracking
      let finalUsage: any = undefined;
      let finalCost: any = undefined;

      for await (const chunk of this.dependencies.llmService.generateResponseStream(messages, llmOptions)) {
        // Check if aborted FIRST before processing chunk
        if (options?.abortSignal?.aborted) {
          throw new DOMException('Generation aborted by user', 'AbortError');
        }

        accumulatedContent += chunk.chunk;

        // Extract usage for cost calculation
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }

        // Extract tool calls when available and handle progressive display
        if (chunk.toolCalls) {
          toolCalls = chunk.toolCalls;

      // Handle progressive tool call detection (fires 'detected' and 'updated' events)
      if (toolCalls) {
        // Only emit once we have non-empty argument content to reduce duplicate spam
        const hasMeaningfulArgs = toolCalls.some((tc: any) => {
          const args = tc.function?.arguments || tc.arguments || '';
          return typeof args === 'string' ? args.trim().length > 0 : true;
        });
        if (hasMeaningfulArgs) {
          this.dependencies.toolCallService.handleToolCallDetection(
            messageId,
            toolCalls,
            chunk.toolCallsReady || false,
            conversationId
          );
        }
      }
        }

        // Save to database BEFORE yielding final chunk to ensure persistence
        if (chunk.complete) {
          // Calculate cost from final usage using CostTrackingService
          if (finalUsage) {
            const usageData = this.dependencies.costTrackingService.extractUsage(finalUsage);
            if (usageData) {
              finalCost = await this.dependencies.costTrackingService.trackMessageUsage(
                conversationId,
                messageId,
                provider,
                llmOptions.model,
                usageData
              );
            }
          }

          // Update the placeholder message with final content
          const conv = await this.dependencies.conversationService.getConversation(conversationId);
          if (conv) {
            const msg = conv.messages.find((m: any) => m.id === messageId);
            if (msg) {
              // Update existing placeholder message
              msg.content = accumulatedContent;
              msg.state = 'complete';
              if (toolCalls) {
                msg.toolCalls = toolCalls;
              }

              // Only update cost/usage if we have values (don't overwrite with undefined)
              // This prevents overwriting async updates from OpenRouter's generation API
              if (finalCost) {
                msg.cost = finalCost;
              }
              if (finalUsage) {
                msg.usage = finalUsage;
              }

              msg.provider = provider;
              msg.model = llmOptions.model;

              // Save updated conversation
              await this.dependencies.conversationService.updateConversation(conversationId, {
                messages: conv.messages,
                metadata: conv.metadata
              });
            }
          }

          // Handle tool calls - if present, add separate message for pingpong response
          if (toolCalls && toolCalls.length > 0) {
            // Had tool calls - the placeholder is the tool call message, add pingpong response separately
            // No separate message needed; placeholder already holds tool calls and final content
          }
        }

        yield {
          chunk: chunk.chunk,
          complete: chunk.complete,
          messageId,
          toolCalls: toolCalls,
          // Pass through reasoning for UI display
          reasoning: chunk.reasoning,
          reasoningComplete: chunk.reasoningComplete,
          // Pass through usage for context tracking
          usage: chunk.complete ? finalUsage : undefined
        };

        if (chunk.complete) {
          break;
        }
      }

    } catch (error) {
      console.error('Error in generateResponse:', error);
      throw error;
    } finally {
      // Notify queue service that generation is complete (resumes processing)
      this.dependencies.messageQueueService?.onGenerationComplete?.();
    }
  }

  /**
   * Build message history for LLM context using provider-specific formatting
   *
   * This method uses ConversationContextBuilder to properly reconstruct
   * conversation history with tool calls in the correct format for each provider.
   *
   * NOTE: For Google, we return simple {role, content} format because
   * StreamingOrchestrator will convert to Google format ({role, parts})
   */
  private buildLLMMessages(conversation: ConversationData, provider?: string, systemPrompt?: string): any[] {
    const currentProvider = provider || this.getCurrentProvider();

    // For Google, return simple format - StreamingOrchestrator handles Google conversion
    if (currentProvider === 'google') {
      const messages: any[] = [];

      // Add system prompt if provided
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      // Add conversation messages in simple format
      for (const msg of conversation.messages) {
        if (msg.role === 'user' && msg.content && msg.content.trim()) {
          messages.push({ role: 'user', content: msg.content });
        } else if (msg.role === 'assistant' && msg.content && msg.content.trim()) {
          messages.push({ role: 'assistant', content: msg.content });
        }
      }

      return messages;
    }

    // For other providers, use ConversationContextBuilder
    return ConversationContextBuilder.buildContextForProvider(
      conversation,
      currentProvider,
      systemPrompt
    );
  }

  /**
   * Get current provider for context building
   */
  private getCurrentProvider(): string {
    return this.currentProvider || this.dependencies.llmService.getDefaultModel().provider;
  }

  /**
   * Set current provider (for context building)
   */
  setProvider(provider: string): void {
    this.currentProvider = provider;
  }
}
