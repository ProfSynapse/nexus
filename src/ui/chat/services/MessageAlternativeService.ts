/**
 * Location: /src/ui/chat/services/MessageAlternativeService.ts
 *
 * Purpose: Handles creation of alternative AI responses for message branching
 * Extracted from MessageManager.ts to follow Single Responsibility Principle
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
 * Service for creating alternative AI responses when retrying messages
 */
export class MessageAlternativeService {
  private currentAbortController: AbortController | null = null;
  private currentStreamingMessageId: string | null = null;

  constructor(
    private chatService: ChatService,
    private branchManager: BranchManager,
    private streamHandler: MessageStreamHandler,
    private abortHandler: AbortHandler,
    private events: MessageAlternativeServiceEvents
  ) {}

  /**
   * Create an alternative response for an AI message
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
    const aiMessage = conversation.messages.find(msg => msg.id === aiMessageId);
    if (!aiMessage || aiMessage.role !== 'assistant') return;

    // Find the user message that prompted this AI response
    const aiMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
    if (aiMessageIndex === 0) return; // No previous message

    const userMessage = conversation.messages[aiMessageIndex - 1];
    if (!userMessage || userMessage.role !== 'user') return;

    // Store the original content, tool calls, and state before retry
    const originalContent = aiMessage.content;
    const originalToolCalls = aiMessage.toolCalls;
    const originalState = aiMessage.state;

    try {
      this.events.onLoadingStateChanged(true);

      // Clear the AI message and show loading state
      const messageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
      if (messageIndex >= 0) {
        conversation.messages[messageIndex].content = '';
        conversation.messages[messageIndex].isLoading = true;
        conversation.messages[messageIndex].state = 'draft';

        // Clear the bubble immediately and show thinking animation
        this.events.onStreamingUpdate(aiMessageId, '', false, false);
        this.events.onConversationUpdated(conversation);
      }

      // Create abort controller for this request
      this.currentAbortController = new AbortController();
      this.currentStreamingMessageId = aiMessageId;

      console.log('[Retry] Calling streamHandler.streamResponse');
      // Stream new AI response
      const { streamedContent, toolCalls } = await this.streamHandler.streamResponse(
        conversation,
        userMessage.content,
        aiMessageId,
        {
          ...options,
          excludeFromMessageId: aiMessageId, // Exclude AI message being retried from context
          abortSignal: this.currentAbortController.signal
        }
      );
      console.log('[Retry] streamResponse completed', { contentLength: streamedContent?.length, hasToolCalls: !!toolCalls });

      // Restore the original content before creating alternative
      const restoreIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
      if (restoreIndex >= 0) {
        conversation.messages[restoreIndex].content = originalContent;
        conversation.messages[restoreIndex].toolCalls = originalToolCalls;
        conversation.messages[restoreIndex].state = originalState || 'complete';
        conversation.messages[restoreIndex].isLoading = false;
      }

      // Create alternative response with the new content
      const alternativeResponse: ConversationMessage = {
        id: `alt_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
        role: 'assistant',
        content: streamedContent,
        timestamp: Date.now(),
        conversationId: conversation.id,
        state: 'complete',
        toolCalls: toolCalls
      };

      // Add alternative using BranchManager
      await this.branchManager.createHumanBranch(
        conversation,
        aiMessageId,
        alternativeResponse
      );

      // Reload conversation from storage
      const freshConversation = await this.chatService.getConversation(conversation.id);
      if (freshConversation) {
        Object.assign(conversation, freshConversation);
      }

      // Notify UI to refresh and show the branching controls
      this.events.onConversationUpdated(conversation);

    } catch (error) {
      // Handle abort scenario
      if (error instanceof Error && error.name === 'AbortError') {
        await this.abortHandler.handleAbort(
          conversation,
          aiMessageId,
          async (hasContent, aiMsg) => {
            if (hasContent) {
              // Keep partial content
              aiMsg.toolCalls = undefined;
              aiMsg.isLoading = false;
              aiMsg.state = 'aborted';
              await this.chatService.updateConversation(conversation);
              this.events.onStreamingUpdate(aiMessageId, aiMsg.content, true, false);
              this.events.onConversationUpdated(conversation);
            } else {
              // Restore original content if aborted before any new content
              aiMsg.content = originalContent;
              aiMsg.toolCalls = originalToolCalls;
              aiMsg.state = originalState || 'complete';
              aiMsg.isLoading = false;
              await this.chatService.updateConversation(conversation);
              this.events.onConversationUpdated(conversation);
            }
          }
        );
      } else {
        this.events.onError('Failed to generate alternative response');
      }
    } finally {
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
