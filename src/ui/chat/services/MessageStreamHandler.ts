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
import { ConversationData } from '../../../types/chat/ChatTypes';

export interface StreamHandlerEvents {
  onStreamingUpdate: (messageId: string, content: string, isComplete: boolean, isIncremental?: boolean) => void;
  onToolCallsDetected: (messageId: string, toolCalls: any[]) => void;
}

export interface StreamOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  messageId?: string;
  excludeFromMessageId?: string;
  abortSignal?: AbortSignal;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
}

export interface StreamResult {
  streamedContent: string;
  toolCalls?: any[];
  reasoning?: string;  // Accumulated reasoning text
  usage?: {            // Token usage for context tracking
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Create a synthetic tool call to represent reasoning/thinking in the UI
 * This allows reasoning to be displayed in the ProgressiveToolAccordion
 */
function createReasoningToolCall(messageId: string, reasoningText: string, isComplete: boolean): any {
  return {
    id: `reasoning_${messageId}`,
    type: 'reasoning',  // Special type for reasoning display
    name: 'Reasoning',
    displayName: 'Reasoning',
    technicalName: 'extended_thinking',
    function: {
      name: 'reasoning',
      arguments: ''  // Not used
    },
    result: reasoningText,
    status: isComplete ? 'completed' : 'streaming',
    success: true,
    isVirtual: true  // Flag to indicate this is not a real tool
  };
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
    let toolCalls: any[] | undefined = undefined;
    let hasStartedStreaming = false;
    let finalUsage: StreamResult['usage'] | undefined = undefined;

    // Reasoning accumulation
    let reasoningAccumulator = '';
    let reasoningEmitted = false;

    // Stream the AI response
    for await (const chunk of this.chatService.generateResponseStreaming(
      conversation.id,
      userMessageContent,
      {
        ...options,
        messageId: aiMessageId
      }
    )) {
      // Handle token chunks
      if (chunk.chunk) {
        streamedContent += chunk.chunk;

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
        this.events.onStreamingUpdate(aiMessageId, chunk.chunk, false, true);
      }

      // Handle reasoning/thinking content (Claude, GPT-5, Gemini)
      if (chunk.reasoning) {
        reasoningAccumulator += chunk.reasoning;

        // Emit reasoning as a synthetic tool call for UI display
        const reasoningToolCall = createReasoningToolCall(
          aiMessageId,
          reasoningAccumulator,
          chunk.reasoningComplete || false
        );
        this.events.onToolCallsDetected(aiMessageId, [reasoningToolCall]);
        reasoningEmitted = true;
      }

      // Mark reasoning as complete if signaled
      if (chunk.reasoningComplete && reasoningEmitted) {
        const finalReasoningToolCall = createReasoningToolCall(
          aiMessageId,
          reasoningAccumulator,
          true
        );
        this.events.onToolCallsDetected(aiMessageId, [finalReasoningToolCall]);
      }

      // Extract tool calls when available
      if (chunk.toolCalls) {
        toolCalls = chunk.toolCalls;

        // Emit tool calls event for final chunk
        if (chunk.complete) {
          this.events.onToolCallsDetected(aiMessageId, toolCalls);
        }
      }

      // Capture usage data when available
      if (chunk.usage) {
        finalUsage = {
          promptTokens: chunk.usage.promptTokens || 0,
          completionTokens: chunk.usage.completionTokens || 0,
          totalTokens: chunk.usage.totalTokens || 0
        };
      }

      // Handle completion
      if (chunk.complete) {
        // Check if this is TRULY the final complete
        const hasToolCalls = toolCalls && toolCalls.length > 0;
        const toolCallsHaveResults = hasToolCalls && toolCalls!.some((tc) =>
          tc.result !== undefined || tc.success !== undefined
        );
        const isFinalComplete = !hasToolCalls || toolCallsHaveResults;

        if (isFinalComplete) {
          // Update conversation with final content
          const placeholderMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
          if (placeholderMessageIndex >= 0) {
            conversation.messages[placeholderMessageIndex] = {
              ...conversation.messages[placeholderMessageIndex],
              content: streamedContent,
              state: 'complete',
              toolCalls: toolCalls,
              // Persist reasoning for re-render from storage
              reasoning: reasoningAccumulator || undefined
            };
          }

          // Send final complete content
          this.events.onStreamingUpdate(aiMessageId, streamedContent, true, false);
          break;
        } else {
          // Intermediate complete - waiting for tool execution results
        }
      }
    }

    return {
      streamedContent,
      toolCalls,
      reasoning: reasoningAccumulator || undefined,
      usage: finalUsage
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
    const result = await this.streamResponse(conversation, userMessageContent, aiMessageId, options);

    // Save conversation to storage (works for both parent and branch)
    await this.chatService.updateConversation(conversation);

    return result;
  }
}
