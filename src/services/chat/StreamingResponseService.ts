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

import { ConversationData, ToolCall } from '../../types/chat/ChatTypes';
import { ConversationContextBuilder } from './ConversationContextBuilder';
import { ToolCallService, type ToolEventData } from './ToolCallService';
import { CostTrackingService, type CostData, type UsageData } from './CostTrackingService';
import type { MessageQueueService } from './MessageQueueService';
import { ContextBudgetService, type NormalizedTokenUsage } from './ContextBudgetService';

interface ChatContextMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

interface ToolCallLike {
  id: string;
  type?: 'function';
  name?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  arguments?: string;
  result?: unknown;
  success?: boolean;
  error?: string;
  providerExecuted?: boolean;
}

interface StreamingChunk {
  chunk: string;
  complete: boolean;
  messageId: string;
  toolCalls?: ToolCallLike[];
  toolCallsReady?: boolean;
  reasoning?: string;
  reasoningComplete?: boolean;
  usage?: UsageData;
}

interface StreamingGenerateOptions {
  provider?: string;
  model?: string;
  tools?: OpenAIToolDefinition[];
  toolChoice?: 'auto' | undefined;
  abortSignal?: AbortSignal;
  sessionId?: string;
  workspaceId?: string;
  conversationId: string;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
  responsesApiId?: string;
  onToolEvent?: (event: 'started' | 'completed', data: ToolEventData) => void;
  onUsageAvailable?: (usage: UsageData, cost: CostData | null) => Promise<void>;
  onResponsesApiId?: (id: string) => Promise<void>;
}

interface DefaultModel {
  provider: string;
  model: string;
}

interface ConversationServiceLike {
  getConversation(id: string): Promise<ConversationData | null>;
  addMessage(params: {
    conversationId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    id?: string;
    toolCalls?: ToolCall[];
  }): Promise<void>;
  updateConversation(id: string, updates: Partial<ConversationData>): Promise<void>;
}

interface LLMServiceLike {
  getDefaultModel(): DefaultModel;
  generateResponseStream(
    messages: ChatContextMessage[],
    options: StreamingGenerateOptions
  ): AsyncGenerator<StreamingChunk, void, unknown>;
}

export interface StreamingOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  messageId?: string;
  abortSignal?: AbortSignal;
  excludeFromMessageId?: string;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
}

export interface StreamingDependencies {
  llmService: LLMServiceLike;
  conversationService: ConversationServiceLike;
  toolCallService: ToolCallService;
  costTrackingService: CostTrackingService;
  messageQueueService?: MessageQueueService;
}

function normalizeToolCalls(toolCalls: ToolCallLike[]): ToolCall[] {
  return toolCalls.map((toolCall) => {
    const functionName = toolCall.function?.name || toolCall.name || '';
    const functionArguments =
      typeof toolCall.function?.arguments === 'string'
        ? toolCall.function.arguments
        : typeof toolCall.arguments === 'string'
          ? toolCall.arguments
          : '';

    return {
      id: toolCall.id,
      type: 'function',
      name: toolCall.name || functionName || undefined,
      function: {
        name: functionName,
        arguments: functionArguments
      },
      result: toolCall.result,
      success: toolCall.success,
      error: toolCall.error,
      providerExecuted: toolCall.providerExecuted
    };
  });
}

function hasMeaningfulToolArguments(toolCalls: ToolCallLike[]): boolean {
  return toolCalls.some((toolCall) => {
    const args = toolCall.function?.arguments || toolCall.arguments || '';
    return typeof args === 'string' ? args.trim().length > 0 : true;
  });
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
    this.dependencies.messageQueueService?.onGenerationStart?.();

    try {
      const messageId = options?.messageId || `msg_${Date.now()}_ai`;
      let accumulatedContent = '';

      const defaultModel = this.dependencies.llmService.getDefaultModel();

      const existingConv = await this.dependencies.conversationService.getConversation(conversationId);
      const messageExists = existingConv?.messages.some((message) => message.id === messageId);

      if (!messageExists) {
        await this.dependencies.conversationService.addMessage({
          conversationId,
          role: 'assistant',
          content: '',
          id: messageId
        });
      }

      const provider = options?.provider || defaultModel.provider;
      this.currentProvider = provider;

      const conversation = await this.dependencies.conversationService.getConversation(conversationId);

      let filteredConversation = conversation;
      if (conversation && options?.excludeFromMessageId) {
        const excludeIndex = conversation.messages.findIndex((message) => message.id === options.excludeFromMessageId);
        if (excludeIndex >= 0) {
          filteredConversation = {
            ...conversation,
            messages: conversation.messages.slice(0, excludeIndex)
          };
        }
      }

      const messages = filteredConversation
        ? this.buildLLMMessages(filteredConversation, provider, options?.systemPrompt)
        : [];

      if (options?.systemPrompt && !messages.some((message) => message.role === 'system')) {
        messages.unshift({ role: 'system', content: options.systemPrompt });
      }

      if (!filteredConversation || !filteredConversation.messages.some((message) => message.content === userMessage && message.role === 'user')) {
        messages.push({ role: 'user', content: userMessage });
      }

      const isWebLLM = provider === 'webllm';
      const openAITools: OpenAIToolDefinition[] = isWebLLM ? [] : this.dependencies.toolCallService.getAvailableTools();

      const llmOptions: StreamingGenerateOptions = {
        provider: options?.provider || defaultModel.provider,
        model: options?.model || defaultModel.model,
        tools: openAITools,
        toolChoice: openAITools.length > 0 ? 'auto' : undefined,
        abortSignal: options?.abortSignal,
        sessionId: options?.sessionId,
        workspaceId: options?.workspaceId,
        conversationId,
        enableThinking: options?.enableThinking,
        thinkingEffort: options?.thinkingEffort,
        temperature: options?.temperature,
        responsesApiId: filteredConversation?.metadata?.responsesApiId
      };

      llmOptions.onToolEvent = (event: 'started' | 'completed', data: ToolEventData) => {
        this.dependencies.toolCallService.fireToolEvent(messageId, event, data);
      };

      llmOptions.onUsageAvailable = this.dependencies.costTrackingService.createUsageCallback(conversationId, messageId);

      llmOptions.onResponsesApiId = async (id: string) => {
        try {
          const conv = await this.dependencies.conversationService.getConversation(conversationId);
          if (conv) {
            await this.dependencies.conversationService.updateConversation(conversationId, {
              metadata: { ...conv.metadata, responsesApiId: id }
            });
          }
        } catch (error) {
          console.error('[StreamingResponseService] Failed to persist responsesApiId:', error);
        }
      };

      let toolCalls: ToolCallLike[] | undefined;
      this.dependencies.toolCallService.resetDetectedTools();

      let finalUsage: UsageData | undefined;
      let finalCost: CostData | undefined;

      for await (const chunk of this.dependencies.llmService.generateResponseStream(messages, llmOptions)) {
        if (options?.abortSignal?.aborted) {
          throw new DOMException('Generation aborted by user', 'AbortError');
        }

        accumulatedContent += chunk.chunk;

        if (chunk.usage) {
          const normalizedUsage: NormalizedTokenUsage | null = ContextBudgetService.normalizeUsage(chunk.usage);
          if (normalizedUsage) {
            finalUsage = normalizedUsage;
          }
        }

        if (chunk.toolCalls) {
          toolCalls = chunk.toolCalls;
        }

        if (toolCalls && hasMeaningfulToolArguments(toolCalls)) {
          this.dependencies.toolCallService.handleToolCallDetection(
            messageId,
            toolCalls,
            chunk.toolCallsReady || false,
            conversationId
          );
        }

        if (chunk.complete) {
          if (finalUsage) {
            const usageData = this.dependencies.costTrackingService.extractUsage(finalUsage);
            if (usageData) {
              finalCost = await this.dependencies.costTrackingService.trackMessageUsage(
                conversationId,
                messageId,
                provider,
                llmOptions.model,
                usageData
              ) || undefined;
            }
          }

          const conv = await this.dependencies.conversationService.getConversation(conversationId);
          if (conv) {
            const msg = conv.messages.find((message) => message.id === messageId);
            if (msg) {
              msg.content = accumulatedContent;
              msg.state = 'complete';
              if (toolCalls) {
                msg.toolCalls = normalizeToolCalls(toolCalls);
              }

              if (finalCost) {
                msg.cost = finalCost;
              }
              if (finalUsage) {
                msg.usage = finalUsage;
              }

              msg.provider = provider;
              msg.model = llmOptions.model;

              await this.dependencies.conversationService.updateConversation(conversationId, {
                messages: conv.messages,
                metadata: conv.metadata
              });
            }
          }
        }

        yield {
          chunk: chunk.chunk,
          complete: chunk.complete,
          messageId,
          toolCalls,
          reasoning: chunk.reasoning,
          reasoningComplete: chunk.reasoningComplete,
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
      await this.dependencies.messageQueueService?.onGenerationComplete?.();
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
  private buildLLMMessages(conversation: ConversationData, provider?: string, systemPrompt?: string): ChatContextMessage[] {
    const currentProvider = provider || this.getCurrentProvider();

    if (currentProvider === 'google') {
      const messages: ChatContextMessage[] = [];

      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      for (const message of conversation.messages) {
        if (message.role === 'user' && message.content && message.content.trim()) {
          messages.push({ role: 'user', content: message.content });
        } else if (message.role === 'assistant' && message.content && message.content.trim()) {
          messages.push({ role: 'assistant', content: message.content });
        }
      }

      return messages;
    }

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
