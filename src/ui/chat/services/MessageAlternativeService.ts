/**
 * Location: /src/ui/chat/services/MessageAlternativeService.ts
 *
 * Purpose: Handles creation of alternative AI responses for message branching
 * Extracted from MessageManager.ts to follow Single Responsibility Principle
 *
 * Uses a staging pattern: the original message is never mutated during retry.
 * A CSS overlay is shown on the existing message, streaming happens into a
 * local variable, and only on success does the conversation state change
 * (via branch creation).
 *
 * Used by: MessageManager for retry and alternative response generation
 * Dependencies: ChatService, BranchManager, MessageStreamHandler
 */

import { ChatService } from '../../../services/chat/ChatService';
import { ConversationData, ConversationMessage } from '../../../types/chat/ChatTypes';
import { BranchManager } from './BranchManager';
import { MessageStreamHandler } from './MessageStreamHandler';
import { AbortHandler } from '../utils/AbortHandler';

export interface MessageAlternativeServiceEvents {
  onStreamingUpdate: (messageId: string, content: string, isComplete: boolean, isIncremental?: boolean) => void;
  onConversationUpdated: (conversation: ConversationData) => void;
  onToolCallsDetected: (messageId: string, toolCalls: any[]) => void;
  onLoadingStateChanged: (isLoading: boolean) => void;
  onError: (message: string) => void;
}

/**
 * Service for creating alternative AI responses when retrying messages.
 *
 * Staging pattern flow:
 * 1. Show CSS overlay on existing message (original content visible underneath)
 * 2. Stream new response into a staging conversation clone (not the live object)
 * 3. On success: create branch with staged content, activeAlternativeIndex set by BranchManager
 * 4. On error/abort: remove overlay, original content untouched
 */
export class MessageAlternativeService {
  private currentAbortController: AbortController | null = null;
  private currentStreamingMessageId: string | null = null;

  /** Guard against concurrent retries on the same message */
  private retryInProgress: Set<string> = new Set();

  constructor(
    private chatService: ChatService,
    private branchManager: BranchManager,
    private streamHandler: MessageStreamHandler,
    private abortHandler: AbortHandler,
    private events: MessageAlternativeServiceEvents
  ) {}

  /**
   * Create an alternative response for an AI message.
   *
   * Uses the staging pattern to avoid mutating the live conversation object
   * during streaming. The original message content is never cleared or modified.
   */
  async createAlternativeResponse(
    conversation: ConversationData,
    aiMessageId: string,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
    }
  ): Promise<void> {
    // Concurrent retry guard: if a retry is already in progress for this message, bail
    if (this.retryInProgress.has(aiMessageId)) {
      return;
    }

    const aiMessage = conversation.messages.find(msg => msg.id === aiMessageId);
    if (!aiMessage || aiMessage.role !== 'assistant') return;

    // Find the user message that prompted this AI response
    const aiMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
    if (aiMessageIndex === 0) return; // No previous message

    const userMessage = conversation.messages[aiMessageIndex - 1];
    if (!userMessage || userMessage.role !== 'user') return;

    // Mark retry as in progress
    this.retryInProgress.add(aiMessageId);

    try {
      this.events.onLoadingStateChanged(true);

      // Show CSS overlay on the existing message bubble (do NOT clear content)
      this.setRetryOverlay(aiMessageId, true);

      // Create abort controller for this request
      this.currentAbortController = new AbortController();
      this.currentStreamingMessageId = aiMessageId;

      // Create a staging conversation clone for the stream handler.
      // The stream handler mutates conversation.messages[index].content during streaming,
      // so we clone the messages array and the target AI message to isolate mutations.
      const stagingConversation = this.createStagingConversation(conversation, aiMessageIndex);

      // Stream new AI response into the staging conversation
      const { streamedContent, toolCalls } = await this.streamHandler.streamResponse(
        stagingConversation,
        userMessage.content,
        aiMessageId,
        {
          ...options,
          excludeFromMessageId: aiMessageId,
          abortSignal: this.currentAbortController.signal
        }
      );

      // Remove the overlay now that streaming is complete
      this.setRetryOverlay(aiMessageId, false);

      // Build the alternative response from staged content
      const alternativeResponse: ConversationMessage = {
        id: `alt_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
        role: 'assistant',
        content: streamedContent,
        timestamp: Date.now(),
        conversationId: conversation.id,
        state: 'complete',
        toolCalls: toolCalls
      };

      // Create branch via BranchManager.
      // BranchManager.createHumanBranch() pushes the branch onto message.branches,
      // sets activeAlternativeIndex to the new branch, and saves to storage.
      // This mutates the live conversation object directly — which is correct,
      // as the branch creation is the single atomic state change.
      await this.branchManager.createHumanBranch(
        conversation,
        aiMessageId,
        alternativeResponse
      );

      // Do NOT reload from storage with Object.assign — BranchManager already
      // updated the conversation object in-place and saved to storage.
      // The old Object.assign(conversation, freshConversation) was overwriting
      // the activeAlternativeIndex that BranchManager just set (Bug #3).

      // Fire a single conversation update for the UI.
      // Phase 2's incremental reconciliation in MessageDisplay will handle
      // re-rendering only the changed message bubble.
      this.events.onConversationUpdated(conversation);

    } catch (error) {
      // Remove overlay on any error
      this.setRetryOverlay(aiMessageId, false);

      if (error instanceof Error && error.name === 'AbortError') {
        // With the staging pattern, the original message was never modified.
        // On abort, we simply remove the overlay and restore the loading state.
        // No content restoration needed — the original is still intact.
        this.events.onConversationUpdated(conversation);
      } else {
        this.events.onError('Failed to generate alternative response');
      }
    } finally {
      this.retryInProgress.delete(aiMessageId);
      this.currentAbortController = null;
      this.currentStreamingMessageId = null;
      this.events.onLoadingStateChanged(false);
    }
  }

  /**
   * Cancel current alternative generation
   */
  cancel(): void {
    if (this.currentAbortController && this.currentStreamingMessageId) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
      this.currentStreamingMessageId = null;
    }
  }

  /**
   * Check if currently generating an alternative
   */
  isGenerating(): boolean {
    return this.currentAbortController !== null;
  }

  /**
   * Create a staging copy of the conversation for isolated streaming.
   *
   * Clones the messages array and the target AI message so the stream handler
   * can mutate the clone without affecting the live conversation. All other
   * messages are shared references (read-only during streaming).
   */
  private createStagingConversation(
    conversation: ConversationData,
    aiMessageIndex: number
  ): ConversationData {
    // Shallow clone messages array
    const clonedMessages = [...conversation.messages];

    // Deep-enough clone of the AI message being retried:
    // reset content and state so streaming starts fresh in the clone
    clonedMessages[aiMessageIndex] = {
      ...clonedMessages[aiMessageIndex],
      content: '',
      state: 'draft',
      isLoading: true,
      toolCalls: undefined
    };

    return {
      ...conversation,
      messages: clonedMessages
    };
  }

  /**
   * Toggle the retry overlay CSS class on the message bubble DOM element.
   *
   * Uses data-message-id attribute selector to find the element, matching the
   * pattern used by StreamingController and ChatView.
   */
  private setRetryOverlay(messageId: string, show: boolean): void {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) return;

    if (show) {
      messageElement.classList.add('message-retrying');
    } else {
      messageElement.classList.remove('message-retrying');
    }
  }
}
