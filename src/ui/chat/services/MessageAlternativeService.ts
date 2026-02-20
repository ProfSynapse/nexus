/**
 * Location: /src/ui/chat/services/MessageAlternativeService.ts
 *
 * Purpose: Handles creation of alternative AI responses for message branching
 * Extracted from MessageManager.ts to follow Single Responsibility Principle
 *
 * Flow:
 * 1. Save the original content as a branch (preserving old response)
 * 2. Clear the current message content and set loading state
 * 3. Fire UI update so the user sees a cleared message with loading indicator
 * 4. Stream the new response directly into the live conversation message
 * 5. On complete: update message, fire final events
 * 6. On abort: keep partial content (original is safe in the branch)
 * 7. Branch arrows allow navigation between original (branch) and new (current)
 *
 * Used by: MessageManager for retry and alternative response generation
 * Dependencies: ChatService, BranchManager, MessageStreamHandler
 */

import { ChatService } from '../../../services/chat/ChatService';
import { ConversationData, ConversationMessage } from '../../../types/chat/ChatTypes';
import { BranchManager } from './BranchManager';
import { MessageStreamHandler } from './MessageStreamHandler';
import { AbortHandler } from '../utils/AbortHandler';
import { filterCompletedToolCalls } from '../utils/toolCallUtils';

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
 * Clear-and-restream flow:
 * 1. Save original content into a branch (preserves old response)
 * 2. Clear message content and stream new response fresh
 * 3. On success: message has new content, branch has old content
 * 4. On abort: keep partial new content (original safe in branch)
 * 5. Branch arrows navigate between new (current) and old (branch)
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
   * Saves the original content as a branch, clears the message,
   * and streams a fresh response directly into the conversation.
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

    const aiMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
    if (aiMessageIndex === -1) return;

    const aiMessage = conversation.messages[aiMessageIndex];
    if (!aiMessage || aiMessage.role !== 'assistant') return;

    // Must have a preceding user message to retry against
    if (aiMessageIndex === 0) return;
    const userMessage = conversation.messages[aiMessageIndex - 1];
    if (!userMessage || userMessage.role !== 'user') return;

    // Mark retry as in progress
    this.retryInProgress.add(aiMessageId);

    try {
      this.events.onLoadingStateChanged(true);

      // 1. Save original content as a branch FIRST (preserves old response)
      const originalContent = aiMessage.content;
      const originalToolCalls = aiMessage.toolCalls ? [...aiMessage.toolCalls] : undefined;
      const originalReasoning = aiMessage.reasoning;

      const branchMessage: ConversationMessage = {
        id: `alt_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
        role: 'assistant',
        content: originalContent,
        timestamp: aiMessage.timestamp,
        conversationId: conversation.id,
        state: aiMessage.state || 'complete',
        toolCalls: originalToolCalls,
        reasoning: originalReasoning
      };

      const branchId = await this.branchManager.createHumanBranch(
        conversation,
        aiMessageId,
        branchMessage
      );

      // 1b. Collect and move continuation messages (e.g. tool-call follow-ups)
      //     that follow the retried AI message into the branch so they don't
      //     linger as stale content after the new response streams in.
      const continuationMessages = conversation.messages.splice(aiMessageIndex + 1);
      if (continuationMessages.length > 0 && branchId) {
        const targetBranch = aiMessage.branches?.find(b => b.id === branchId);
        if (targetBranch) {
          targetBranch.messages.push(...continuationMessages);
          targetBranch.updated = Date.now();
          // Persist the branch with its continuation messages
          await this.chatService.updateConversation(conversation);
        }
      }

      // 2. Clear the current message for fresh streaming
      aiMessage.content = '';
      aiMessage.toolCalls = undefined;
      aiMessage.reasoning = undefined;
      aiMessage.isLoading = true;
      aiMessage.state = 'draft';

      // Set activeAlternativeIndex to 0 so the UI shows the current message
      // (the original content is now in the branch, navigable via branch arrows)
      aiMessage.activeAlternativeIndex = 0;

      // 3. Fire UI update so the user sees the cleared message with loading state
      this.events.onConversationUpdated(conversation);

      // 4. Create abort controller for this retry
      this.currentAbortController = new AbortController();
      this.currentStreamingMessageId = aiMessageId;

      // 5. Get user message content for the LLM request
      const userMessageContent = userMessage.content;

      // 6. Stream new response directly into the live conversation
      // The stream handler mutates conversation.messages[aiMessageIndex] in-place,
      // fires onStreamingUpdate events for live UI updates, and handles tool calls.
      await this.streamHandler.streamResponse(
        conversation,
        userMessageContent,
        aiMessageId,
        {
          ...options,
          excludeFromMessageId: aiMessageId,
          abortSignal: this.currentAbortController.signal
        }
      );

      // 7. After streaming completes, save the updated conversation
      await this.chatService.updateConversation(conversation);

      // 8. Fire final UI update
      this.events.onConversationUpdated(conversation);

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // On abort: keep whatever partial content was streamed.
        // The original response is safe in the branch.
        const abortedMessage = conversation.messages[aiMessageIndex];
        if (abortedMessage) {
          const hasContent = abortedMessage.content && abortedMessage.content.trim();

          if (hasContent) {
            // Keep partial content, clean up incomplete tool calls
            abortedMessage.toolCalls = filterCompletedToolCalls(abortedMessage.toolCalls);
            abortedMessage.isLoading = false;
            abortedMessage.state = 'aborted';

            await this.chatService.updateConversation(conversation);
            this.events.onStreamingUpdate(aiMessageId, abortedMessage.content, true, false);
          } else {
            // No content streamed yet - mark as aborted with empty content
            abortedMessage.isLoading = false;
            abortedMessage.state = 'aborted';
            abortedMessage.content = '';

            await this.chatService.updateConversation(conversation);
          }
        }

        this.events.onConversationUpdated(conversation);
      } else {
        // B2 fix: Reset loading state on the message so it doesn't stay in "thinking"
        const failedMessage = conversation.messages[aiMessageIndex];
        if (failedMessage) {
          failedMessage.isLoading = false;
          failedMessage.state = 'error';
          try {
            await this.chatService.updateConversation(conversation);
          } catch {
            // Best-effort persist — don't mask the original error
          }
        }
        this.events.onConversationUpdated(conversation);
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
}
