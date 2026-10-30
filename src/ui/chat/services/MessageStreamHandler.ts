import { projectTurn } from '../../../services/chat/ChatTurnStore';
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
import type { OverloadRetryNotice } from '../../../services/llm/adapters/types';
import {
  ConversationData,
  ReasoningSegment,
  ToolCall as ConversationToolCall,
} from '../../../types/chat/ChatTypes';
import {
  createInitialChatTurnState,
  reduceChatTurn,
} from '../../../services/llm/runtime/ChatTurnReducer';

export interface StreamHandlerEvents {
  onStreamingUpdate: (messageId: string, content: string, isComplete: boolean, isIncremental?: boolean) => void;
  onConversationUpdated?: (conversation: ConversationData) => void;
  onToolCallsDetected: (messageId: string, toolCalls: ConversationToolCall[]) => void;
  onCostUpdate?: () => void;
  onToolLimitReached?: (completedToolCalls: number, abortSignal?: AbortSignal) => Promise<boolean>;
  onReasoningUpdate?: (
    messageId: string,
    reasoningText: string,
    isComplete: boolean,
    segments?: ReasoningSegment[]
  ) => void;
  /** An overloaded provider is being retried (notice), or output has started (null). */
  onProviderRetrying?: (messageId: string, notice: OverloadRetryNotice | null) => void;
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
  onToolLimitReached?: (completedToolCalls: number, abortSignal?: AbortSignal) => Promise<boolean>;
  enableThinking?: boolean;
  webSearch?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  /** That reasoning split into the runs the model emitted, anchored to content offsets */
  reasoningSegments?: ReasoningSegment[];
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
    options: StreamOptions,
    onTerminalEvent?: () => void
  ): Promise<StreamResult> {
    const initialConversationCost = conversation.cost?.totalCost ?? 0;
    const initialMessageCost = conversation.messages.find(msg => msg.id === aiMessageId)?.cost?.totalCost ?? 0;
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
    let reasoningSegments: ReasoningSegment[] = [];
    let sawTerminalEvent = false;
    let showingRetryNotice = false;

    // Stream the AI response
    for await (const chunk of this.chatService.generateResponseStreaming(
      conversation.id,
      userMessageContent,
      {
        ...options,
        onToolLimitReached: options.onToolLimitReached ?? this.events.onToolLimitReached,
        messageId: aiMessageId
      }
    )) {
      const event = chunk.event;
      // Production events carry the shared runtime projection. The reducer
      // fallback supports legacy injected producers during migration.
      if (chunk.snapshot && this.chatService.turnStore && !this.chatService.turnStore.isCurrent(chunk.snapshot)) continue;
      turnState = chunk.snapshot?.state ?? reduceChatTurn(turnState, event);
      const messageIndex = conversation.messages.findIndex(message => message.id === aiMessageId);
      if (messageIndex >= 0 && chunk.snapshot) {
        conversation.messages[messageIndex] = projectTurn(conversation.messages[messageIndex], chunk.snapshot);
      }

      streamedContent = turnState.content;
      reasoningAccumulator = turnState.reasoning.text;
      reasoningSegments = turnState.reasoning.segments;
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

      if (event.type === 'provider.retrying') {
        showingRetryNotice = true;
        const { provider, retry, maxRetries, delayMs } = event;
        this.events.onProviderRetrying?.(aiMessageId, { provider, retry, maxRetries, delayMs });
      } else if (showingRetryNotice && (event.type === 'assistant.delta' || event.type === 'reasoning.delta' || event.type === 'tool.snapshot')) {
        showingRetryNotice = false;
        this.events.onProviderRetrying?.(aiMessageId, null);
      }

      if (event.type === 'cost.updated') {
        const message = conversation.messages.find(msg => msg.id === aiMessageId);
        if (message) message.cost = event.cost;
        conversation.cost = {
          totalCost: initialConversationCost - initialMessageCost + event.cost.totalCost,
          currency: event.cost.currency,
        };
        this.events.onCostUpdate?.();
      }

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
      if (!chunk.snapshot && event.type === 'reasoning.delta') {
        // Push the accumulated reasoning to the UI for live "Thinking" rendering
        this.events.onReasoningUpdate?.(
          aiMessageId,
          reasoningAccumulator,
          turnState.reasoning.complete,
          reasoningSegments
        );
      }

      // Mark reasoning as complete if signaled
      if (!chunk.snapshot && event.type === 'reasoning.completed') {
        this.events.onReasoningUpdate?.(aiMessageId, reasoningAccumulator, true, reasoningSegments);
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
            reasoningSegments: reasoningSegments.length > 0 ? reasoningSegments : undefined,
            metadata: finalMetadata,
            provider: resolvedProvider,
            model: resolvedModel,
            cost: finalCost,
            usage: finalUsage,
          };
        }

        this.events.onStreamingUpdate(aiMessageId, streamedContent, true, false);
        sawTerminalEvent = true;
        onTerminalEvent?.();
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
            reasoningSegments: reasoningSegments.length > 0 ? reasoningSegments : undefined,
            metadata: finalMetadata,
            provider: resolvedProvider,
            model: resolvedModel,
            cost: finalCost,
            usage: finalUsage,
          };
        }
        if (event.type === 'turn.failed') {
          // The producer already persisted the failed state, but the visible
          // bubble still holds its pre-token loader (or an open text parser).
          // Finalize that UI stream before the error is reported upstream.
          this.events.onStreamingUpdate(aiMessageId, streamedContent, true, false);
          // The bubble still holds the pre-terminal message snapshot. Reconcile
          // its state so a partial Thinking block closes on failure as well.
          this.events.onConversationUpdated?.(conversation);
        }
        sawTerminalEvent = true;
        onTerminalEvent?.();
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
      reasoningSegments: turnState.reasoning.segments.length > 0
        ? turnState.reasoning.segments
        : undefined,
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
    let sawTerminalEvent = false;
    try {
      const result = await this.streamResponse(conversation, userMessageContent, aiMessageId, options, () => {
        sawTerminalEvent = true;
      });
      // StreamingResponseService persists the terminal message before yielding
      // it. Saving this UI snapshot again can overwrite a provider charge that
      // arrived just after the stream closed (OpenRouter generation fallback).
      return result;
    } catch (error) {
      // Terminal abort/failure events were also persisted by the producer.
      // Only errors before a terminal event need this UI snapshot saved.
      if (!sawTerminalEvent && !this.chatService.turnStore) {
        try {
          const saved = await this.chatService.updateConversation(conversation);
          if (!saved.success) throw new Error(saved.error || 'Could not save partial response');
        } catch (saveError) {
          console.error('[MessageStreamHandler] Failed to save partial response:', saveError);
        }
      }
      throw error;
    }
  }
}
