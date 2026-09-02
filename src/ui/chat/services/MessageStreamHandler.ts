/**
 * Location: /src/ui/chat/services/MessageStreamHandler.ts
 *
 * Purpose: Consolidated streaming loop logic for AI responses
 * Extracted from MessageManager.ts to eliminate DRY violations (4+ repeated streaming patterns)
 *
 * ARCHITECTURE NOTE (Dec 2025):
 * A branch IS a conversation with parent metadata. When viewing a branch,
 * the branch is set as currentConversation. This means all streaming saves
 * go through ChatService.updateConversation() - no special routing needed.
 *
 * Used by: MessageManager, MessageAlternativeService for streaming AI responses
 * Dependencies: ChatService
 */

import { ChatService } from '../../../services/chat/ChatService';
import { ConversationData, ToolCall as ConversationToolCall } from '../../../types/chat/ChatTypes';
import {
  createInitialChatTurnState,
  reduceChatTurn,
} from '../../../services/llm/runtime/ChatTurnReducer';

export interface StreamHandlerEvents {
  onStreamingUpdate: (messageId: string, content: string, isComplete: boolean, isIncremental?: boolean) => void;
  onToolCallsDetected: (messageId: string, toolCalls: ConversationToolCall[]) => void;
  onReasoningUpdate?: (messageId: string, reasoningText: string, isComplete: boolean) => void;
}

export interface StreamOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  messageId?: string;
  operationOrigin?: import('../../../types/tools/ToolOperationTypes').ToolExecutionOrigin;
  operationScopeId?: string;
  excludeFromMessageId?: string;
  abortSignal?: AbortSignal;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
  imageProvider?: 'google' | 'openrouter' | 'openai';
  imageModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
}

export interface StreamResult {
  streamedContent: string;
  toolCalls?: ConversationToolCall[];
  reasoning?: string;  // Accumulated reasoning text
  metadata?: Record<string, unknown>;
  usage?: {            // Token usage for context tracking
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider?: string;   // Resolved provider from final chunk
  model?: string;      // Resolved model from final chunk
  cost?: { totalCost: number; currency: string };
}

/**
 * Handles streaming of AI responses with unified logic
 */
export class MessageStreamHandler {
  constructor(
    private chatService: ChatService,
    private events: StreamHandlerEvents
  ) {}

  /**
   * Stream AI response with consolidated logic
   * This eliminates the 4+ repeated streaming loop patterns in MessageManager
   */
  async streamResponse(
    conversation: ConversationData,
    userMessageContent: string,
    aiMessageId: string,
    options: StreamOptions
  ): Promise<StreamResult> {
    let streamedContent = '';
    let toolCalls: ConversationToolCall[] | undefined = undefined;
    let hasStartedStreaming = false;
    let finalUsage: StreamResult['usage'] | undefined = undefined;
    let finalMetadata: Record<string, unknown> | undefined = undefined;
    let resolvedProvider: string | undefined = undefined;
    let resolvedModel: string | undefined = undefined;
    let finalCost: StreamResult['cost'] | undefined = undefined;
    let turnState = createInitialChatTurnState();

    let reasoningAccumulator = '';
    let sawTerminalEvent = false;

    // Stream the AI response
    for await (const chunk of this.chatService.generateResponseStreaming(
      conversation.id,
      userMessageContent,
      {
        ...options,
        messageId: aiMessageId
      }
    )) {
      const event = chunk.event;
      turnState = reduceChatTurn(turnState, event);

      streamedContent = turnState.content;
      reasoningAccumulator = turnState.reasoning.text;
      toolCalls = turnState.toolCalls.length > 0
        ? turnState.toolCalls
        : undefined;
      finalUsage = turnState.usage;
      finalMetadata = Object.keys(turnState.metadata).length > 0
        ? turnState.metadata
        : undefined;
      resolvedProvider = turnState.provider;
      resolvedModel = turnState.model;
      finalCost = turnState.cost;

      // Handle token events
      if (event.type === 'assistant.delta') {
        // Update message in conversation object progressively
        // This ensures partial content is preserved if user stops generation
        const messageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
        if (messageIndex >= 0) {
          // Update state to streaming on first chunk
          if (!hasStartedStreaming) {
            hasStartedStreaming = true;
            conversation.messages[messageIndex].state = 'streaming';
            conversation.messages[messageIndex].isLoading = false;
          }
          // Always update content so it's available on abort
          conversation.messages[messageIndex].content = streamedContent;
        }

        // Send only the new chunk to UI for incremental updates
        this.events.onStreamingUpdate(aiMessageId, event.text, false, true);
      }

      // Handle reasoning/thinking content (Claude, GPT-5, Gemini)
      if (event.type === 'reasoning.delta') {
        // Push the accumulated reasoning to the UI for live "Thinking" rendering
        this.events.onReasoningUpdate?.(
          aiMessageId,
          reasoningAccumulator,
          turnState.reasoning.complete
        );
      }

      // Mark reasoning as complete if signaled
      if (event.type === 'reasoning.completed') {
        this.events.onReasoningUpdate?.(aiMessageId, reasoningAccumulator, true);
      }

      if (event.type === 'tool.snapshot' && event.ready && toolCalls) {
        this.events.onToolCallsDetected(aiMessageId, toolCalls);
      }

      if (event.type === 'turn.completed') {
        const placeholderMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
        if (placeholderMessageIndex >= 0) {
          conversation.messages[placeholderMessageIndex] = {
            ...conversation.messages[placeholderMessageIndex],
            content: streamedContent,
            state: 'complete',
            // Clear the loading spinner on completion. Without this, a
            // complete-but-empty stream (no token ever arrived) leaves the
            // placeholder's isLoading:true and the chat spins forever, because
            // isLoading is otherwise only cleared on the first token
            // (issue #271, claim b).
            isLoading: false,
            toolCalls,
            // Persist reasoning for re-render from storage
            reasoning: reasoningAccumulator || undefined,
            metadata: finalMetadata,
            provider: resolvedProvider,
            model: resolvedModel,
            cost: finalCost,
            usage: finalUsage,
          };
        }

        this.events.onStreamingUpdate(aiMessageId, streamedContent, true, false);
        sawTerminalEvent = true;
        break;
      }

      if (event.type === 'turn.aborted' || event.type === 'turn.failed') {
        const placeholderMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
        if (placeholderMessageIndex >= 0) {
          conversation.messages[placeholderMessageIndex] = {
            ...conversation.messages[placeholderMessageIndex],
            content: streamedContent,
            state: event.type === 'turn.aborted' ? 'aborted' : 'invalid',
            isLoading: false,
            toolCalls,
            reasoning: reasoningAccumulator || undefined,
            metadata: finalMetadata,
            provider: resolvedProvider,
            model: resolvedModel,
            cost: finalCost,
            usage: finalUsage,
          };
        }
        sawTerminalEvent = true;
      }
    }

    if (!sawTerminalEvent || !turnState.terminalEvent) {
      throw new Error('Chat runtime stream ended without a terminal turn event.');
    }

    if (turnState.terminalEvent.type === 'turn.aborted') {
      throw new DOMException(
        turnState.terminalEvent.reason || 'Generation aborted by user',
        'AbortError'
      );
    }

    if (turnState.terminalEvent.type === 'turn.failed') {
      throw new Error(turnState.terminalEvent.error.message);
    }

    return {
      streamedContent: turnState.content,
      toolCalls: turnState.toolCalls.length > 0
        ? turnState.toolCalls
        : undefined,
      reasoning: turnState.reasoning.text || undefined,
      metadata: Object.keys(turnState.metadata).length > 0
        ? turnState.metadata
        : undefined,
      usage: turnState.usage,
      provider: turnState.provider,
      model: turnState.model,
      cost: turnState.cost,
    };
  }

  /**
   * Stream response and save to storage
   * Convenience method that combines streaming and saving
   *
   * ARCHITECTURE NOTE (Dec 2025):
   * The conversation passed here is the currentConversation, which is
   * either a parent conversation or a branch (branch IS a conversation).
   * ChatService.updateConversation handles both the same way.
   */
  async streamAndSave(
    conversation: ConversationData,
    userMessageContent: string,
    aiMessageId: string,
    options: StreamOptions
  ): Promise<StreamResult> {
    try {
      const result = await this.streamResponse(conversation, userMessageContent, aiMessageId, options);
      await this.chatService.updateConversation(conversation);
      return result;
    } catch (error) {
      // Terminal abort/failure events update the in-memory placeholder before
      // the producer rethrows. Persist that partial state as part of the same
      // stream contract so callers cannot lose it by handling the exception.
      await this.chatService.updateConversation(conversation);
      throw error;
    }
  }
}
