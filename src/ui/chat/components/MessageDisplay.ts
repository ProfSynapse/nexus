/**
 * MessageDisplay - Main chat message display area
 *
 * Shows conversation messages with user and assistant bubbles.
 */

import { ConversationData, ConversationMessage } from '../../../types/chat/ChatTypes';
import { MessageBubble } from './MessageBubble';
import { BranchManager } from '../services/BranchManager';
import { App, setIcon, ButtonComponent } from 'obsidian';

export class MessageDisplay {
  private conversation: ConversationData | null = null;
  private currentConversationId: string | null = null;
  private messageBubbles: Map<string, MessageBubble> = new Map();
  private transientEventRow: HTMLElement | null = null;

  constructor(
    private container: HTMLElement,
    private app: App,
    private branchManager: BranchManager,
    private onRetryMessage?: (messageId: string) => void,
    private onEditMessage?: (messageId: string, newContent: string) => void,
    private onMessageAlternativeChanged?: (messageId: string, alternativeIndex: number) => void
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
      if (message.metadata?.hidden) {
        continue;
      }
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

    this.ensureTransientEventRowPosition(messagesContainer as HTMLElement);
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
    if (message.metadata?.hidden) {
      return;
    }
    const bubble = this.createMessageBubble(message);
    this.container.querySelector('.messages-container')?.appendChild(bubble);
    this.ensureTransientEventRowPosition(this.container.querySelector('.messages-container'));
    this.scrollToBottom();
  }

  /**
   * Add an AI message immediately (for streaming setup)
   */
  addAIMessage(message: ConversationMessage): void {
    const bubble = this.createMessageBubble(message);
    this.container.querySelector('.messages-container')?.appendChild(bubble);
    this.ensureTransientEventRowPosition(this.container.querySelector('.messages-container'));
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

    // Collect boundary message IDs from compaction frontier for divider insertion
    const boundaryIds = this.getCompactionBoundaryIds();

    // Render all messages (no branch filtering needed for message-level alternatives)
    this.conversation.messages.forEach((message) => {
      if (message.metadata?.hidden) {
        return;
      }

      // Insert compaction divider before boundary messages (persisted across reload)
      const boundaryRecord = boundaryIds.get(message.id);
      if (boundaryRecord) {
        const divider = this.createCompactionDividerElement(boundaryRecord.messagesRemoved);
        messagesContainer.appendChild(divider);
      }

      const messageEl = this.createMessageBubble(message);
      messagesContainer.appendChild(messageEl);
    });

    this.ensureTransientEventRowPosition(messagesContainer);

    this.scrollToBottom();
  }

  showTransientEventRow(message: string): void {
    if (!message.trim()) {
      this.clearTransientEventRow();
      return;
    }

    if (!this.transientEventRow) {
      this.transientEventRow = this.createTransientEventRow(message);
    } else {
      const textEl = this.transientEventRow.querySelector('.message-display-event-text');
      if (textEl) {
        textEl.textContent = message;
      }
    }

    this.ensureTransientEventRowPosition(this.container.querySelector('.messages-container'));
    this.scrollToBottom();
  }

  clearTransientEventRow(): void {
    if (this.transientEventRow) {
      this.transientEventRow.remove();
      this.transientEventRow = null;
    }
  }

  /**
   * Insert a visual compaction divider into the message list.
   * The divider is a non-message DOM element that survives incremental
   * reconciliation (reconcile only touches messageBubbles) but is
   * cleared on full re-render (conversation switch).
   */
  showCompactionDivider(messagesRemoved: number): void {
    const messagesContainer = this.container.querySelector('.messages-container');
    if (!messagesContainer) {
      return;
    }

    const divider = this.createCompactionDividerElement(messagesRemoved);

    // Insert before the transient event row if present, otherwise append
    if (this.transientEventRow && this.transientEventRow.parentElement === messagesContainer) {
      messagesContainer.insertBefore(divider, this.transientEventRow);
    } else {
      messagesContainer.appendChild(divider);
    }

    this.scrollToBottom();
  }

  /**
   * Create a compaction divider DOM element.
   * Reused by showCompactionDivider (live) and render (persisted from metadata).
   */
  private createCompactionDividerElement(messagesRemoved: number): HTMLElement {
    const divider = document.createElement('div');
    divider.className = 'compaction-divider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', `${messagesRemoved} messages compacted`);

    const rule1 = document.createElement('span');
    rule1.className = 'compaction-divider-rule';
    divider.appendChild(rule1);

    const label = document.createElement('span');
    label.className = 'compaction-divider-label';
    label.textContent = 'Compacted';
    divider.appendChild(label);

    const rule2 = document.createElement('span');
    rule2.className = 'compaction-divider-rule';
    divider.appendChild(rule2);

    return divider;
  }

  /**
   * Extract compaction boundary message IDs from conversation metadata.
   * Returns a Map of boundaryMessageId → { messagesRemoved } for divider insertion.
   */
  private getCompactionBoundaryIds(): Map<string, { messagesRemoved: number }> {
    const boundaries = new Map<string, { messagesRemoved: number }>();
    const metadata = this.conversation?.metadata;
    if (!metadata) return boundaries;

    const compaction = metadata.compaction as { frontier?: Array<{ boundaryMessageId?: string; messagesRemoved?: number }> } | undefined;
    const frontier = compaction?.frontier;
    if (!Array.isArray(frontier)) return boundaries;

    for (const record of frontier) {
      if (record.boundaryMessageId) {
        boundaries.set(record.boundaryMessageId, {
          messagesRemoved: record.messagesRemoved ?? 0
        });
      }
    }

    return boundaries;
  }

  private createTransientEventRow(message: string): HTMLElement {
    const row = this.container.createDiv('message-display-event-row');
    row.setAttribute('role', 'status');
    row.setAttribute('aria-live', 'polite');
    row.setAttribute('aria-atomic', 'true');

    const pill = row.createDiv('message-display-event-pill');
    pill.createSpan({ cls: 'message-display-event-dot' });
    pill.createSpan({
      cls: 'message-display-event-text',
      text: message
    });

    return row;
  }

  private ensureTransientEventRowPosition(messagesContainer: HTMLElement | null): void {
    if (!messagesContainer || !this.transientEventRow) {
      return;
    }

    messagesContainer.appendChild(this.transientEventRow);
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
      this.onMessageAlternativeChanged ? (messageId: string, alternativeIndex: number) => this.handleMessageAlternativeChanged(messageId, alternativeIndex) : undefined
    );

    this.messageBubbles.set(message.id, bubble);

    const bubbleEl = bubble.createElement();

    return bubbleEl;
  }

  /**
   * Handle copy message action
   */
  private onCopyMessage(messageId: string): void {
    const message = this.findMessage(messageId);
    if (message) {
      const content = this.branchManager
        ? this.branchManager.getActiveMessageContent(message)
        : message.content;
      navigator.clipboard.writeText(content).then(() => {
        // Message copied to clipboard
      }).catch(() => {
        // Failed to copy message
        return;
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
    this.clearTransientEventRow();
    this.currentConversationId = null;
  }
}
