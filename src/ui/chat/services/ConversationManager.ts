/**
 * ConversationManager - Handles all conversation CRUD operations
 */

import { App } from 'obsidian';
import { ChatService } from '../../../services/chat/ChatService';
import { ConversationData } from '../../../types/chat/ChatTypes';
import { BranchManager } from './BranchManager';
import { ConversationTitleModal } from '../components/ConversationTitleModal';

export interface ConversationManagerEvents {
  onConversationSelected: (conversation: ConversationData) => void;
  onConversationsChanged: () => void;
  onError: (message: string) => void;
}

export class ConversationManager {
  private currentConversation: ConversationData | null = null;
  private conversations: ConversationData[] = [];

  constructor(
    private app: App,
    private chatService: ChatService,
    private branchManager: BranchManager,
    private events: ConversationManagerEvents
  ) {}

  /**
   * Get current conversation
   */
  getCurrentConversation(): ConversationData | null {
    return this.currentConversation;
  }

  /**
   * Get all conversations
   */
  getConversations(): ConversationData[] {
    return this.conversations;
  }

  /**
   * Load conversations from the chat service
   */
  async loadConversations(): Promise<void> {
    try {
      this.conversations = await this.chatService.listConversations({ limit: 50 });

      this.events.onConversationsChanged();

      // Auto-select the most recent conversation
      if (this.conversations.length > 0 && !this.currentConversation) {
        await this.selectConversation(this.conversations[0]);
      }
    } catch (error) {
      this.events.onError('Failed to load conversations');
    }
  }

  /**
   * Select and display a conversation
   */
  async selectConversation(conversation: ConversationData): Promise<void> {
    try {
      this.currentConversation = conversation;

      // Load full conversation data
      const fullConversation = await this.chatService.getConversation(conversation.id);

      if (fullConversation) {
        this.currentConversation = fullConversation;
        this.events.onConversationSelected(fullConversation);
      }
    } catch (error) {
      this.events.onError('Failed to load conversation');
    }
  }

  /**
   * Create a new conversation
   */
  async createNewConversation(title?: string): Promise<void> {
    try {
      // Prompt for title if not provided
      const conversationTitle = title || await this.promptForConversationTitle();
      if (!conversationTitle) return; // User cancelled

      const result = await this.chatService.createConversation(conversationTitle);

      if (result.success && result.conversationId) {
        // Reload conversations and select the new one
        await this.loadConversations();
        const newConversation = await this.chatService.getConversation(result.conversationId);
        if (newConversation) {
          await this.selectConversation(newConversation);
        }
      } else {
        this.events.onError(result.error || 'Failed to create conversation');
      }
    } catch (error) {
      this.events.onError('Failed to create conversation');
    }
  }

  /**
   * Create new conversation with initial message
   */
  async createNewConversationWithMessage(
    message: string,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
    }
  ): Promise<void> {
    const title = message.length > 50 ? message.substring(0, 47) + '...' : message;

    try {
      const result = await this.chatService.createConversation(
        title,
        message,
        {
          ...options,
          workspaceId: options?.workspaceId
        }
      );

      if (result.success && result.conversationId && result.sessionId) {
        // Reload conversations and select the new one
        await this.loadConversations();
        const newConversation = await this.chatService.getConversation(result.conversationId);

        if (newConversation) {
          await this.selectConversation(newConversation);
        }
      } else if (result.success && result.conversationId) {
        // Fallback for conversations without session ID (shouldn't happen with new code)
        await this.loadConversations();
        const newConversation = await this.chatService.getConversation(result.conversationId);
        if (newConversation) {
          await this.selectConversation(newConversation);
        }
      } else {
        this.events.onError(result.error || 'Failed to create conversation');
      }
    } catch (error) {
      this.events.onError('Failed to create conversation');
    }
  }

  /**
   * Delete a conversation
   */
  async deleteConversation(conversationId: string): Promise<void> {
    try {
      const success = await this.chatService.deleteConversation(conversationId);

      if (success) {
        // If this was the current conversation, clear it
        if (this.currentConversation?.id === conversationId) {
          this.currentConversation = null;
        }

        // Reload conversation list
        await this.loadConversations();
      } else {
        this.events.onError('Failed to delete conversation');
      }
    } catch (error) {
      this.events.onError('Failed to delete conversation');
    }
  }

  /**
   * Rename a conversation
   */
  async renameConversation(conversationId: string, newTitle: string): Promise<void> {
    try {
      const success = await this.chatService.updateConversationTitle(conversationId, newTitle);

      if (success) {
        // Update current conversation title if this is the active one
        if (this.currentConversation?.id === conversationId) {
          this.currentConversation.title = newTitle;
        }

        // Update title in the local conversations list
        const conversation = this.conversations.find(c => c.id === conversationId);
        if (conversation) {
          conversation.title = newTitle;
        }

        // Notify UI of the change
        this.events.onConversationsChanged();
      } else {
        this.events.onError('Failed to rename conversation');
      }
    } catch (error) {
      this.events.onError('Failed to rename conversation');
    }
  }

  /**
   * Update current conversation data
   */
  updateCurrentConversation(conversation: ConversationData): void {
    this.currentConversation = conversation;
  }

  /**
   * Prompt user for conversation title using Obsidian's Modal
   */
  private async promptForConversationTitle(): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new ConversationTitleModal(this.app, (title) => {
        resolve(title);
      });
      modal.open();
    });
  }

}