/**
 * MessageDisplay - Main chat message display area
 *
 * Shows conversation messages with user/AI bubbles and tool execution displays
 */

import { ConversationData, ConversationMessage } from '../../../types/chat/ChatTypes';
import { MessageBubble } from './MessageBubble';
import { BranchManager } from '../services/BranchManager';
import { App, setIcon, ButtonComponent } from 'obsidian';

export class MessageDisplay {
  private conversation: ConversationData | null = null;
  private currentConversationId: string | null = null;
  private messageBubbles: Map<string, MessageBubble> = new Map();

  constructor(
    private container: HTMLElement,
    private app: App,
    private branchManager: BranchManager,
    private onRetryMessage?: (messageId: string) => void,
    private onEditMessage?: (messageId: string, newContent: string) => void,
    private onToolEvent?: (messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: any) => void,
    private onMessageAlternativeChanged?: (messageId: string, alternativeIndex: number) => void,
    private onViewBranch?: (branchId: string) => void
  ) {
    this.render();
  }

  /**
   * Set conversation to display.
   * Uses incremental reconciliation when updating the same conversation (preserves
   * live progressive tool accordions, branch navigator state, and avoids flicker).
   * Falls back to full render when switching to a different conversation.
   */
  setConversation(conversation: ConversationData): void {
    const previousConversationId = this.currentConversationId;
    this.conversation = conversation;
    this.currentConversationId = conversation.id;

    // Full render for conversation switches or first load
    if (previousConversationId !== conversation.id) {
      this.render();
      this.scrollToBottom();
      return;
    }

    // Incremental reconciliation for same conversation updates
    this.reconcile(conversation);
    this.scrollToBottom();
  }

  /**
   * Incrementally reconcile the displayed messages with the new conversation data.
   * Reuses existing MessageBubble instances for messages that still exist,
   * removes stale ones, and creates new ones -- preserving live UI state.
   */
  private reconcile(conversation: ConversationData): void {
    const messagesContainer = this.container.querySelector('.messages-container');
    if (!messagesContainer) {
      // No messages container yet (e.g., was showing welcome) -- fall back to full render
      this.render();
      return;
    }

    const newMessages = conversation.messages;
    const newMessageIds = new Set(newMessages.map(m => m.id));

    // 1. Remove stale bubbles (messages no longer in conversation)
    for (const [id, bubble] of this.messageBubbles) {
      if (!newMessageIds.has(id)) {
        const element = bubble.getElement();
        if (element) {
          element.remove();
        }
        bubble.cleanup();
        this.messageBubbles.delete(id);
      }
    }

    // 2. Walk new messages in order: update existing, create new, ensure DOM order
    let previousElement: Element | null = null;
    for (const message of newMessages) {
      const existingBubble = this.messageBubbles.get(message.id);

      if (existingBubble) {
        // Update the existing bubble in place
        existingBubble.updateWithNewMessage(message);
        const element = existingBubble.getElement();

        // Ensure DOM order: element should follow previousElement
        if (element) {
          const expectedNext: Element | null = previousElement ? previousElement.nextElementSibling : messagesContainer.firstElementChild;
          if (element !== expectedNext) {
            if (previousElement) {
              previousElement.after(element);
            } else {
              messagesContainer.prepend(element);
            }
          }
          previousElement = element;
        }
      } else {
        // Create a new bubble for this message
        const bubbleEl = this.createMessageBubble(message);

        // Insert at the correct position
        if (previousElement) {
          previousElement.after(bubbleEl);
        } else {
          messagesContainer.prepend(bubbleEl);
        }
        previousElement = bubbleEl;
      }
    }
  }

  /**
   * Add a user message immediately (for optimistic updates)
   */
  addUserMessage(content: string): void {
    const message: ConversationMessage = {
      id: `temp_${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
      conversationId: this.conversation?.id || 'unknown'
    };

    const bubble = this.createMessageBubble(message);
    const messagesContainer = this.container.querySelector('.messages-container');
    if (messagesContainer) {
      messagesContainer.appendChild(bubble);
    }
    this.scrollToBottom();
  }

  /**
   * Add a message immediately using the actual message object (prevents duplicate message creation)
   */
  addMessage(message: ConversationMessage): void {
    const bubble = this.createMessageBubble(message);
    this.container.querySelector('.messages-container')?.appendChild(bubble);
    this.scrollToBottom();
  }

  /**
   * Add an AI message immediately (for streaming setup)
   */
  addAIMessage(message: ConversationMessage): void {
    const bubble = this.createMessageBubble(message);
    this.container.querySelector('.messages-container')?.appendChild(bubble);
    this.scrollToBottom();
  }

  /**
   * Update a specific message content for final display (streaming handled by StreamingController)
   */
  updateMessageContent(messageId: string, content: string): void {
    const messageBubble = this.messageBubbles.get(messageId);
    if (messageBubble) {
      messageBubble.updateContent(content);
    }
  }

  /**
   * Update a specific message with new data (including tool calls) without full re-render
   */
  updateMessage(messageId: string, updatedMessage: ConversationMessage): void {
    if (!this.conversation) {
      return;
    }

    // Update the message in conversation data
    const messageIndex = this.conversation.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex !== -1) {
      this.conversation.messages[messageIndex] = updatedMessage;
    }

    // Update the bubble in place
    const messageBubble = this.messageBubbles.get(messageId);
    if (messageBubble) {
      messageBubble.updateWithNewMessage(updatedMessage);
    }
  }

  /**
   * Escape HTML for safe display
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }


  /**
   * Show welcome state
   */
  showWelcome(): void {
    this.container.empty();
    this.container.addClass('message-display');

    const welcome = this.container.createDiv('chat-welcome');
    const welcomeContent = welcome.createDiv('chat-welcome-content');

    const welcomeIcon = welcomeContent.createDiv('chat-welcome-icon');
    setIcon(welcomeIcon, 'message-circle');

    // Use Obsidian's ButtonComponent
    new ButtonComponent(welcomeContent)
      .setButtonText('New conversation')
      .setIcon('plus')
      .setClass('chat-welcome-button');
  }

  /**
   * Full render - destroys all existing bubbles and rebuilds from scratch.
   * Used for conversation switches and initial load.
   */
  private render(): void {
    // Cleanup all existing bubbles before clearing the DOM
    for (const bubble of this.messageBubbles.values()) {
      bubble.cleanup();
    }
    this.messageBubbles.clear();

    this.container.empty();
    this.container.addClass('message-display');

    if (!this.conversation) {
      this.showWelcome();
      return;
    }

    // Create scrollable messages container
    const messagesContainer = this.container.createDiv('messages-container');

    // Render all messages (no branch filtering needed for message-level alternatives)
    this.conversation.messages.forEach((message) => {
      const messageEl = this.createMessageBubble(message);
      messagesContainer.appendChild(messageEl);
    });

    this.scrollToBottom();
  }

  /**
   * Create a message bubble element
   */
  private createMessageBubble(message: ConversationMessage): HTMLElement {
    // Render using the currently active alternative content/tool calls so branch selection persists across re-renders
    const displayMessage = this.branchManager
      ? {
          ...message,
          content: this.branchManager.getActiveMessageContent(message),
          toolCalls: this.branchManager.getActiveMessageToolCalls(message)
        }
      : message;

    const bubble = new MessageBubble(
      displayMessage,
      this.app,
      (messageId: string) => this.onCopyMessage(messageId),
      (messageId: string) => this.handleRetryMessage(messageId),
      (messageId: string, newContent: string) => this.handleEditMessage(messageId, newContent),
      this.onToolEvent,
      this.onMessageAlternativeChanged ? (messageId: string, alternativeIndex: number) => this.handleMessageAlternativeChanged(messageId, alternativeIndex) : undefined,
      this.onViewBranch
    );

    this.messageBubbles.set(message.id, bubble);

    const bubbleEl = bubble.createElement();

    // Tool accordion is now rendered inside MessageBubble's content area

    return bubbleEl;
  }

  /**
   * Handle copy message action
   */
  private onCopyMessage(messageId: string): void {
    const message = this.findMessage(messageId);
    if (message) {
      navigator.clipboard.writeText(message.content).then(() => {
        // Message copied to clipboard
      }).catch(err => {
        // Failed to copy message
      });
    }
  }

  /**
   * Handle retry message action
   */
  private handleRetryMessage(messageId: string): void {
    if (this.onRetryMessage) {
      this.onRetryMessage(messageId);
    }
  }

  /**
   * Handle edit message action
   */
  private handleEditMessage(messageId: string, newContent: string): void {
    if (this.onEditMessage) {
      this.onEditMessage(messageId, newContent);
    }
  }

  /**
   * Handle message alternative changed action
   */
  private handleMessageAlternativeChanged(messageId: string, alternativeIndex: number): void {
    if (this.onMessageAlternativeChanged) {
      this.onMessageAlternativeChanged(messageId, alternativeIndex);
    }
  }

  /**
   * Find message by ID
   */
  private findMessage(messageId: string): ConversationMessage | undefined {
    return this.conversation?.messages.find(msg => msg.id === messageId);
  }

  /**
   * Find MessageBubble by messageId for tool events
   */
  findMessageBubble(messageId: string): MessageBubble | undefined {
    return this.messageBubbles.get(messageId);
  }

  /**
   * Update MessageBubble with new message ID (for handling temporary -> real ID updates)
   */
  updateMessageId(oldId: string, newId: string, updatedMessage: ConversationMessage): void {
    const messageBubble = this.messageBubbles.get(oldId);
    if (messageBubble) {
      // Re-key the bubble in the Map under the new ID
      this.messageBubbles.delete(oldId);
      this.messageBubbles.set(newId, messageBubble);

      // Update the MessageBubble's message reference and DOM attribute
      messageBubble.updateWithNewMessage(updatedMessage);

      const element = messageBubble.getElement();
      if (element) {
        element.setAttribute('data-message-id', newId);
      }
    }
  }

  /**
   * Check if any message bubbles have progressive tool accordions
   */
  hasProgressiveToolAccordions(): boolean {
    for (const bubble of this.messageBubbles.values()) {
      if (bubble.getProgressiveToolAccordions().size > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Scroll to bottom of messages
   */
  private scrollToBottom(): void {
    const messagesContainer = this.container.querySelector('.messages-container');
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  /**
   * Get current scroll position
   */
  getScrollPosition(): number {
    const messagesContainer = this.container.querySelector('.messages-container');
    return messagesContainer?.scrollTop ?? 0;
  }

  /**
   * Set scroll position
   */
  setScrollPosition(position: number): void {
    const messagesContainer = this.container.querySelector('.messages-container');
    if (messagesContainer) {
      messagesContainer.scrollTop = position;
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    for (const bubble of this.messageBubbles.values()) {
      bubble.cleanup();
    }
    this.messageBubbles.clear();
    this.currentConversationId = null;
  }
}
