/**
 * Location: /src/ui/chat/services/MessageStateManager.ts
 *
 * Purpose: Manages message state transitions and updates
 * Extracted from MessageManager.ts to follow Single Responsibility Principle
 *
 * Used by: MessageManager for managing message lifecycle states
 * Dependencies: ChatService
 */

import { ConversationData, ConversationMessage, ChatMessage } from '../../../types/chat/ChatTypes';
import { ChatService } from '../../../services/chat/ChatService';
import type { BranchService } from '../../../services/chat/BranchService';
import type { BranchOperationContext } from './MessageManager';

export interface MessageStateManagerEvents {
  onMessageAdded: (message: ConversationMessage) => void;
  onAIMessageStarted: (message: ConversationMessage) => void;
  onMessageIdUpdated: (oldId: string, newId: string, updatedMessage: ConversationMessage) => void;
  onConversationUpdated: (conversation: ConversationData) => void;
}

/**
 * Manages message state transitions and lifecycle
 * Supports both conversation mode and branch mode
 */
export class MessageStateManager {
  // Branch support
  private branchService: BranchService | null = null;
  private branchContext: BranchOperationContext | null = null;

  constructor(
    private chatService: ChatService,
    private events: MessageStateManagerEvents
  ) {}

  /**
   * Set branch service for branch operations
   */
  setBranchService(branchService: BranchService): void {
    this.branchService = branchService;
  }

  /**
   * Set branch context - when set, saves go to the branch
   */
  setBranchContext(context: BranchOperationContext | null): void {
    this.branchContext = context;
  }

  /**
   * Create and add a user message to the conversation
   * In branch mode, saves to branch storage instead of conversation
   */
  async addUserMessage(
    conversation: ConversationData,
    content: string,
    metadata?: any
  ): Promise<ConversationMessage> {
    // Create user message with temporary ID
    const userMessage: ConversationMessage = {
      id: `msg_${Date.now()}_user`,
      role: 'user' as const,
      content: content,
      timestamp: Date.now(),
      conversationId: conversation.id,
      state: 'complete', // User messages are complete when created
      metadata: metadata
    };

    // Add to conversation and display immediately
    conversation.messages.push(userMessage);
    this.events.onMessageAdded(userMessage);

    // Persist to storage based on mode
    if (this.branchContext && this.branchService) {
      // Branch mode: save to branch storage
      const branchMessage: ChatMessage = {
        id: userMessage.id,
        role: 'user',
        content: content,
        timestamp: userMessage.timestamp,
        conversationId: this.branchContext.conversationId,
        metadata: metadata
      };
      await this.branchService.addMessageToBranch(
        this.branchContext.conversationId,
        this.branchContext.parentMessageId,
        this.branchContext.branchId,
        branchMessage
      );
    } else {
      // Normal mode: save to conversation storage
      const userMessageResult = await this.chatService.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: content,
        metadata: metadata,
        id: userMessage.id // Use same ID as in-memory message to avoid mismatch
      });

      // Update with real ID from repository
      if (userMessageResult.success && userMessageResult.messageId) {
        await this.updateMessageId(conversation, userMessage.id, userMessageResult.messageId, userMessage);
      }
    }

    return userMessage;
  }

  /**
   * Create and add a placeholder AI message
   */
  createPlaceholderAIMessage(
    conversation: ConversationData,
    customId?: string
  ): ConversationMessage {
    const aiMessageId = customId || `msg_${Date.now()}_ai`;
    const placeholderAiMessage: ConversationMessage = {
      id: aiMessageId,
      role: 'assistant' as const,
      content: '',
      timestamp: Date.now(),
      conversationId: conversation.id,
      state: 'draft', // Placeholder - about to start streaming
      isLoading: true
    };

    // Add placeholder AI message and create bubble for streaming
    conversation.messages.push(placeholderAiMessage);
    this.events.onAIMessageStarted(placeholderAiMessage);

    return placeholderAiMessage;
  }

  /**
   * Update message ID when real ID is received from storage
   */
  private async updateMessageId(
    conversation: ConversationData,
    tempId: string,
    realId: string,
    message: ConversationMessage
  ): Promise<void> {
    const tempMessageIndex = conversation.messages.findIndex(msg => msg.id === tempId);
    if (tempMessageIndex >= 0) {
      const oldId = conversation.messages[tempMessageIndex].id;
      conversation.messages[tempMessageIndex].id = realId;

      // Update the original message object that UI components reference
      message.id = realId;

      // Notify UI about message ID update so MessageBubble can update its reference
      this.events.onMessageIdUpdated(oldId, realId, message);
    }
  }

  /**
   * Remove a message from conversation
   */
  removeMessage(conversation: ConversationData, messageId: string): void {
    const messageIndex = conversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex >= 0) {
      conversation.messages.splice(messageIndex, 1);
      this.events.onConversationUpdated(conversation);
    }
  }

  /**
   * Update message content
   * In branch mode, updates in-memory only (editing in branches is edge case)
   */
  async updateMessageContent(
    conversation: ConversationData,
    messageId: string,
    newContent: string
  ): Promise<void> {
    const messageIndex = conversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    // Update message content in-memory
    conversation.messages[messageIndex].content = newContent;
    if (conversation.messages[messageIndex].metadata) {
      delete conversation.messages[messageIndex].metadata;
    }

    // Persist to storage based on mode
    if (this.branchContext && this.branchService) {
      // Branch mode: in-memory update only for now
      // TODO: Add updateMessageInBranch to BranchService if editing in branches becomes common
    } else {
      // Normal mode: persist to conversation storage
      await this.chatService.updateConversation(conversation);
    }

    // Notify about conversation update
    this.events.onConversationUpdated(conversation);
  }

  /**
   * Update message state
   */
  updateMessageState(
    conversation: ConversationData,
    messageId: string,
    state: 'draft' | 'streaming' | 'complete' | 'aborted' | 'invalid'
  ): void {
    const messageIndex = conversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex >= 0) {
      conversation.messages[messageIndex].state = state;
    }
  }

  /**
   * Reload conversation from storage to sync with saved messages
   * In branch mode, reloads from branch storage
   */
  async reloadConversation(conversation: ConversationData): Promise<void> {
    if (this.branchContext && this.branchService) {
      // Branch mode: reload branch messages
      const branchInfo = await this.branchService.getBranch(
        this.branchContext.conversationId,
        this.branchContext.branchId
      );
      if (branchInfo) {
        // Update the virtual conversation's messages with fresh branch data
        conversation.messages = branchInfo.branch.messages as ConversationMessage[];
      }
    } else {
      // Normal mode: reload from conversation storage
      const freshConversation = await this.chatService.getConversation(conversation.id);
      if (freshConversation) {
        Object.assign(conversation, freshConversation);
      }
    }
  }
}
