/**
 * ConversationList - Sidebar component for managing conversations
 *
 * Displays list of conversations with create/delete/rename functionality
 */

import { setIcon, Component } from 'obsidian';
import { ConversationData } from '../../../types/chat/ChatTypes';

export class ConversationList {
  private conversations: ConversationData[] = [];
  private activeConversationId: string | null = null;
  private pendingDeleteConversationId: string | null = null;
  private pendingDeleteTimer: number | null = null;
  private _hasMore = false;
  private _isLoading = false;
  private _isSearchActive = false;
  private loadMoreBtn: HTMLButtonElement | null = null;

  constructor(
    private container: HTMLElement,
    private onConversationSelect: (conversation: ConversationData) => void,
    private onConversationDelete: (conversationId: string) => void,
    private onConversationRename?: (conversationId: string, newTitle: string) => void,
    private component?: Component,
    private onLoadMore?: () => void
  ) {
    this.render();
  }

  /**
   * Set conversations to display
   */
  setConversations(conversations: ConversationData[]): void {
    // Shallow copy to avoid mutating the caller's array.
    // Only sort by updated when browsing — search results preserve relevance ordering.
    this.conversations = this._isSearchActive
      ? [...conversations]
      : [...conversations].sort((a, b) => b.updated - a.updated);
    this.render();
  }

  /**
   * Update pagination state for Load More button visibility
   */
  setHasMore(hasMore: boolean): void {
    this._hasMore = hasMore;
    this.updateLoadMoreButton();
  }

  /**
   * Update loading state for Load More button
   */
  setIsLoading(isLoading: boolean): void {
    this._isLoading = isLoading;
    this.updateLoadMoreButton();
  }

  /**
   * Update search state for contextual empty state message
   */
  setIsSearchActive(isSearchActive: boolean): void {
    this._isSearchActive = isSearchActive;
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
    this.loadMoreBtn = null; // container.empty() destroys child nodes
    this.container.addClass('conversation-list');

    if (this.conversations.length === 0) {
      const emptyState = this.container.createDiv('conversation-list-empty');
      emptyState.textContent = this._isSearchActive
        ? 'No results found'
        : 'No conversations yet';
      return;
    }

    this.conversations.forEach(conversation => {
      const item = this.container.createDiv('conversation-item');

      if (conversation.id === this.activeConversationId) {
        item.addClass('active');
      }

      // Main conversation content
      const content = item.createDiv('conversation-content');
      const selectHandler = () => {
        this.onConversationSelect(conversation);
      };
      this.component?.registerDomEvent(content, 'click', selectHandler);

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
        const editHandler = (e: MouseEvent) => {
          e.stopPropagation();
          this.showRenameInput(item, content, conversation);
        };
        this.component?.registerDomEvent(editBtn, 'click', editHandler);
      }

      // Delete button - uses clickable-icon for proper icon sizing
      const deleteBtn = actions.createEl('button', {
        cls: 'conversation-action-btn conversation-delete-btn clickable-icon'
      });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.setAttribute('aria-label', 'Delete conversation');
      const deleteHandler = (e: MouseEvent) => {
        e.stopPropagation();
        this.requestDeleteConversation(conversation);
      };
      this.component?.registerDomEvent(deleteBtn, 'click', deleteHandler);
    });

    // Load More button
    this.renderLoadMoreButton();
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
    const input = createEl('input', { cls: 'conversation-rename-input' });
    input.type = 'text';
    input.value = currentTitle;

    // Replace title with input
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    // Hide action buttons while editing
    const actions = item.querySelector('.conversation-actions') as HTMLElement;
    if (actions) {
      actions.addClass('conversation-actions-hidden');
    }

    const finishRename = (save: boolean) => {
      const newTitle = input.value.trim();

      // Restore title element
      const newTitleEl = createEl('div', {
        cls: 'conversation-title',
        text: save && newTitle ? newTitle : currentTitle,
      });
      input.replaceWith(newTitleEl);

      // Restore action buttons
      if (actions) {
        actions.removeClass('conversation-actions-hidden');
      }

      // Call rename callback if title changed
      if (save && newTitle && newTitle !== currentTitle && this.onConversationRename) {
        this.onConversationRename(conversation.id, newTitle);
      }
    };

    // Handle blur (save on focus loss)
    const blurHandler = () => finishRename(true);

    // Handle keyboard events
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur(); // Trigger blur handler to save
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Remove blur handler before restoring to avoid double-save
        input.removeEventListener('blur', blurHandler);
        finishRename(false);
      }
    };

    this.component?.registerDomEvent(input, 'blur', blurHandler);
    this.component?.registerDomEvent(input, 'keydown', keydownHandler);
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

  private requestDeleteConversation(conversation: ConversationData): void {
    if (this.pendingDeleteConversationId === conversation.id) {
      this.clearPendingDeleteConversation();
      this.onConversationDelete(conversation.id);
      return;
    }

    this.pendingDeleteConversationId = conversation.id;
    if (this.pendingDeleteTimer !== null) {
      window.clearTimeout(this.pendingDeleteTimer);
    }
    this.pendingDeleteTimer = window.setTimeout(() => {
      this.clearPendingDeleteConversation();
    }, 5000);
  }

  private clearPendingDeleteConversation(): void {
    this.pendingDeleteConversationId = null;
    if (this.pendingDeleteTimer !== null) {
      window.clearTimeout(this.pendingDeleteTimer);
      this.pendingDeleteTimer = null;
    }
  }

  /**
   * Render the Load More button at the bottom of the list.
   * Creates the button once and reuses it across updates.
   */
  private renderLoadMoreButton(): void {
    if (!this._hasMore || !this.onLoadMore) return;

    if (!this.loadMoreBtn) {
      this.loadMoreBtn = this.container.createEl('button', {
        cls: 'conversation-load-more-btn',
      });
      this.loadMoreBtn.setAttribute('aria-label', 'Load more conversations');
      const handler = () => {
        if (!this._isLoading) {
          this.onLoadMore?.();
        }
      };
      this.component?.registerDomEvent(this.loadMoreBtn, 'click', handler);
    } else {
      this.container.appendChild(this.loadMoreBtn);
    }

    this.syncLoadMoreButtonState();
  }

  /**
   * Sync Load More button text and disabled state to current loading state
   */
  private syncLoadMoreButtonState(): void {
    if (!this.loadMoreBtn) return;
    this.loadMoreBtn.textContent = this._isLoading ? 'Loading...' : 'Load more';
    if (this._isLoading) {
      this.loadMoreBtn.setAttribute('disabled', 'true');
    } else {
      this.loadMoreBtn.removeAttribute('disabled');
    }
  }

  /**
   * Update Load More button visibility/state without full re-render
   */
  private updateLoadMoreButton(): void {
    if (this._hasMore && this.onLoadMore && this.conversations.length > 0) {
      if (this.loadMoreBtn) {
        if (!this.loadMoreBtn.parentElement) {
          this.container.appendChild(this.loadMoreBtn);
        }
        this.syncLoadMoreButtonState();
      } else {
        this.renderLoadMoreButton();
      }
    } else if (this.loadMoreBtn?.parentElement) {
      this.loadMoreBtn.remove();
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.clearPendingDeleteConversation();
  }
}
