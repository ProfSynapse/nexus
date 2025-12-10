/**
 * ConversationList - Sidebar component for managing conversations
 *
 * Displays list of conversations with create/delete/rename functionality
 */

import { setIcon } from 'obsidian';
import { ConversationData } from '../../../types/chat/ChatTypes';

export class ConversationList {
  private conversations: ConversationData[] = [];
  private activeConversationId: string | null = null;

  constructor(
    private container: HTMLElement,
    private onConversationSelect: (conversation: ConversationData) => void,
    private onConversationDelete: (conversationId: string) => void,
    private onConversationRename?: (conversationId: string, newTitle: string) => void
  ) {
    this.render();
  }

  /**
   * Set conversations to display
   */
  setConversations(conversations: ConversationData[]): void {
    this.conversations = conversations.sort((a, b) => b.updated - a.updated);
    this.render();
  }

  /**
   * Set active conversation
   */
  setActiveConversation(conversationId: string): void {
    this.activeConversationId = conversationId;
    this.updateActiveState();
  }

  /**
   * Render the conversation list
   */
  private render(): void {
    this.container.empty();
    this.container.addClass('conversation-list');

    if (this.conversations.length === 0) {
      const emptyState = this.container.createDiv('conversation-list-empty');
      emptyState.textContent = 'No conversations yet';
      return;
    }

    this.conversations.forEach(conversation => {
      const item = this.container.createDiv('conversation-item');

      if (conversation.id === this.activeConversationId) {
        item.addClass('active');
      }

      // Main conversation content
      const content = item.createDiv('conversation-content');
      content.addEventListener('click', () => {
        this.onConversationSelect(conversation);
      });

      // Title
      const title = content.createDiv('conversation-title');
      title.textContent = conversation.title;

      // Last message preview
      const lastMessage = conversation.messages[conversation.messages.length - 1];
      if (lastMessage) {
        const preview = content.createDiv('conversation-preview');
        const previewText = lastMessage.content.length > 60
          ? lastMessage.content.substring(0, 60) + '...'
          : lastMessage.content;
        preview.textContent = previewText;
      }

      // Timestamp
      const timestamp = content.createDiv('conversation-timestamp');
      timestamp.textContent = this.formatTimestamp(conversation.updated);

      // Action buttons container
      const actions = item.createDiv('conversation-actions');

      // Edit/rename button - uses clickable-icon for proper icon sizing
      if (this.onConversationRename) {
        const editBtn = actions.createEl('button', {
          cls: 'conversation-action-btn conversation-edit-btn clickable-icon'
        });
        setIcon(editBtn, 'pencil');
        editBtn.setAttribute('aria-label', 'Rename conversation');
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.showRenameInput(item, content, conversation);
        });
      }

      // Delete button - uses clickable-icon for proper icon sizing
      const deleteBtn = actions.createEl('button', {
        cls: 'conversation-action-btn conversation-delete-btn clickable-icon'
      });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.setAttribute('aria-label', 'Delete conversation');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this conversation?')) {
          this.onConversationDelete(conversation.id);
        }
      });
    });
  }

  /**
   * Show inline rename input for a conversation
   */
  private showRenameInput(
    item: HTMLElement,
    content: HTMLElement,
    conversation: ConversationData
  ): void {
    const titleEl = content.querySelector('.conversation-title') as HTMLElement;
    if (!titleEl) return;

    const currentTitle = conversation.title;

    // Create input element
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.className = 'conversation-rename-input';

    // Replace title with input
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    // Hide action buttons while editing
    const actions = item.querySelector('.conversation-actions') as HTMLElement;
    if (actions) {
      actions.style.opacity = '0';
      actions.style.pointerEvents = 'none';
    }

    const finishRename = (save: boolean) => {
      const newTitle = input.value.trim();

      // Restore title element
      const newTitleEl = document.createElement('div');
      newTitleEl.className = 'conversation-title';
      newTitleEl.textContent = save && newTitle ? newTitle : currentTitle;
      input.replaceWith(newTitleEl);

      // Restore action buttons
      if (actions) {
        actions.style.opacity = '';
        actions.style.pointerEvents = '';
      }

      // Call rename callback if title changed
      if (save && newTitle && newTitle !== currentTitle && this.onConversationRename) {
        this.onConversationRename(conversation.id, newTitle);
      }
    };

    // Handle blur (save on focus loss)
    input.addEventListener('blur', () => finishRename(true));

    // Handle keyboard events
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur(); // Trigger blur handler to save
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Remove blur handler before restoring to avoid double-save
        input.removeEventListener('blur', () => finishRename(true));
        finishRename(false);
      }
    });
  }

  /**
   * Update active state styling
   */
  private updateActiveState(): void {
    const items = this.container.querySelectorAll('.conversation-item');
    items.forEach((item, index) => {
      const conversation = this.conversations[index];
      if (conversation && conversation.id === this.activeConversationId) {
        item.addClass('active');
      } else {
        item.removeClass('active');
      }
    });
  }

  /**
   * Format timestamp for display
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // Clean up any event listeners if needed
  }
}
