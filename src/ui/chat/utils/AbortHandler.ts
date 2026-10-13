/**
 * Location: /src/ui/chat/utils/AbortHandler.ts
 *
 * Purpose: Unified abort handling utility for AI message generation
 * Extracted from MessageManager.ts to eliminate DRY violations (4+ repeated abort patterns)
 *
 * Used by: MessageManager, MessageAlternativeService for handling abort scenarios
 * Dependencies: ChatService
 */

import { ConversationData, ConversationMessage } from '../../../types/chat/ChatTypes';
import { ChatService } from '../../../services/chat/ChatService';
import { filterCompletedToolCalls } from './toolCallUtils';

export interface AbortHandlerEvents {
  onStreamingUpdate: (messageId: string, content: string, isComplete: boolean, isIncremental?: boolean) => void;
  onConversationUpdated: (conversation: ConversationData) => void;
}

/**
 * Handles abort scenarios for AI message generation
 * Consolidates repeated abort handling logic throughout MessageManager
 */
export class AbortHandler {
  constructor(
    private chatService: ChatService,
    private events: AbortHandlerEvents
  ) {}

  /**
   * Handle abort for an AI message being generated
   *
   * @param conversation - The conversation containing the message
   * @param aiMessageId - ID of the AI message being generated
   * @param customHandler - Optional custom handler for specific abort scenarios
   */
  async handleAbort(
    conversation: ConversationData,
    aiMessageId: string | null,
    customHandler?: (hasContent: boolean, aiMessage: ConversationMessage) => Promise<void>
  ): Promise<void> {
    if (!aiMessageId) return;

    const aiMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
    if (aiMessageIndex < 0) return;

    const aiMessage = conversation.messages[aiMessageIndex];
    if (this.chatService.turnStore?.get(conversation.id, aiMessageId)?.state.terminalEvent) {
      this.events.onStreamingUpdate(aiMessageId, aiMessage.content, true, false);
      this.events.onConversationUpdated(conversation);
      return;
    }

    const completedToolCalls = filterCompletedToolCalls(aiMessage.toolCalls);
    const hasContent = !!(aiMessage.content?.trim() || completedToolCalls?.length || aiMessage.reasoning?.trim());

    // Use custom handler if provided
    if (customHandler) {
      await customHandler(!!hasContent, aiMessage);
      return;
    }

    // Default abort handling
    if (hasContent) {
      // Keep partial response - clean up incomplete tool calls
      aiMessage.toolCalls = completedToolCalls;
      aiMessage.isLoading = false;
      aiMessage.state = 'aborted'; // Mark as aborted (will be included in context)

      // Save conversation with cleaned partial message
      const saved = await this.chatService.updateConversation(conversation);
      if (!saved.success) throw new Error(saved.error || 'Could not save aborted response');

      // Finalize streaming with partial content (stops animation, renders final content)
      this.events.onStreamingUpdate(aiMessageId, aiMessage.content, true, false);

      // Update UI to show final partial message
      this.events.onConversationUpdated(conversation);
    } else {
      // No content generated - mark as invalid and delete
      aiMessage.state = 'invalid'; // Mark as invalid (will be filtered from context)
      aiMessage.isLoading = false;

      // Delete the empty message entirely
      conversation.messages.splice(aiMessageIndex, 1);

      // Save conversation without the empty message
      const saved = await this.chatService.updateConversation(conversation);
      if (!saved.success) throw new Error(saved.error || 'Could not save aborted response');

      // Update UI to remove the empty message bubble
      this.events.onConversationUpdated(conversation);
    }
  }

  /**
   * Check if an error is an abort error
   */
  isAbortError(error: unknown): boolean {
    return (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError';
  }

  /**
   * Handle abort with error checking
   * Convenience method that checks if error is abort before handling
   */
  async handleIfAbortError(
    error: unknown,
    conversation: ConversationData,
    aiMessageId: string | null,
    customHandler?: (hasContent: boolean, aiMessage: ConversationMessage) => Promise<void>
  ): Promise<boolean> {
    if (this.isAbortError(error)) {
      await this.handleAbort(conversation, aiMessageId, customHandler);
      return true;
    }
    return false;
  }

  /**
   * Finalize the assistant placeholder after a NON-abort generation error.
   *
   * Clear a pre-token loader or finalize a partial stream after an unexpected
   * error. Both paths mark the message invalid, preserve partial content, and
   * notify the UI so its animation and streaming parser stop.
   *
   * @param conversation - The conversation containing the placeholder
   * @param aiMessageId - ID of the AI message being generated (may be null)
   */
  async finalizeErroredPlaceholder(
    conversation: ConversationData,
    aiMessageId: string | null
  ): Promise<void> {
    if (!aiMessageId) return;

    const aiMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
    if (aiMessageIndex < 0) return;

    const aiMessage = conversation.messages[aiMessageIndex];
    if (this.chatService.turnStore?.get(conversation.id, aiMessageId)?.state.terminalEvent) {
      this.events.onStreamingUpdate(aiMessageId, aiMessage.content, true, false);
      this.events.onConversationUpdated(conversation);
      return;
    }


    // A first token clears isLoading but leaves state='streaming'. That stream
    // still needs terminal UI cleanup. Persisted terminal states need no work.
    if (aiMessage.isLoading !== true && aiMessage.state !== 'streaming') return;

    aiMessage.isLoading = false;
    aiMessage.state = 'invalid'; // Errored before completion - exclude from context

    // Stop the visible loader even if persistence fails. The failed save is
    // still surfaced to the caller after the UI has reached its terminal state.
    this.events.onStreamingUpdate(aiMessageId, aiMessage.content, true, false);
    // Re-render so the failed state and removed spinner appear immediately.
    this.events.onConversationUpdated(conversation);

    // Persist so a reload doesn't resurrect the stuck loading state.
    await this.chatService.updateMessage(conversation.id, aiMessageId, { state: 'invalid', content: aiMessage.content });
  }
}
