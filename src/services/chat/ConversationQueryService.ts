/**
 * ConversationQueryService - Handles read operations for conversations
 *
 * Responsibilities:
 * - Get conversation by ID
 * - List conversations with pagination
 * - Search conversations
 * - Repository access for advanced queries
 *
 * Follows Single Responsibility Principle - only handles read operations.
 */

import { ConversationData, ChatMessage } from '../../types/chat/ChatTypes';
import { PaginationParams, PaginatedResult } from '../../types/pagination/PaginationTypes';

/** Conversation metadata from list operations */
interface ConversationMetadata {
  id: string;
  title: string;
  created: number;
  updated: number;
  vault_name?: string;
  message_count?: number;
}

/** Conversation service interface for queries */
interface ConversationServiceLike {
  getConversation: (id: string, pagination?: PaginationParams) => Promise<ConversationData | null>;
  listConversations: (vaultName?: string, limit?: number) => Promise<ConversationMetadata[]>;
  searchConversations: (query: string, limit?: number) => Promise<ConversationMetadata[]>;
  getMessages?: (conversationId: string, options?: PaginationParams) => Promise<PaginatedResult<ChatMessage>>;
  getRepository?: () => unknown;
  count?: () => Promise<number>;
}

export class ConversationQueryService {
  constructor(
    private conversationService: ConversationServiceLike
  ) {}

  /**
   * Get a conversation by ID
   *
   * @param id - Conversation ID
   * @param paginationOptions - Optional pagination parameters for message loading
   * @returns Conversation data with paginated messages
   */
  async getConversation(
    id: string,
    paginationOptions?: PaginationParams
  ): Promise<ConversationData | null> {
    try {
      return await this.conversationService.getConversation(id, paginationOptions);
    } catch (error) {
      console.error('Failed to get conversation:', error);
      return null;
    }
  }

  /**
   * Get messages for a conversation (paginated)
   *
   * Allows fetching messages without loading full conversation metadata.
   * Useful for lazy loading and infinite scroll implementations.
   *
   * @param conversationId - Conversation ID
   * @param options - Pagination parameters
   * @returns Paginated result containing messages
   */
  async getMessages(
    conversationId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<ChatMessage>> {
    try {
      if (!this.conversationService.getMessages) {
        return {
          items: [],
          page: 0,
          pageSize: options?.pageSize ?? 50,
          totalItems: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPreviousPage: false
        };
      }
      return await this.conversationService.getMessages(conversationId, options);
    } catch (error) {
      console.error('Failed to get messages:', error);
      return {
        items: [],
        page: 0,
        pageSize: options?.pageSize ?? 50,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false
      };
    }
  }

  /**
   * List all conversations
   */
  async listConversations(options?: {
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<ConversationData[]> {
    try {
      // ConversationService.listConversations expects (vaultName?: string, limit?: number)
      // We pass undefined for vaultName to get all conversations, and extract limit from options
      const metadataList = await this.conversationService.listConversations(undefined, options?.limit);

      // Convert ConversationMetadata to ConversationData format
      // Note: messages array is empty since we're only using the index (lightweight)
      return metadataList.map((metadata: ConversationMetadata) => ({
        id: metadata.id,
        title: metadata.title,
        messages: [], // Empty for list view - messages loaded when conversation is selected
        created: metadata.created,
        updated: metadata.updated,
        metadata: {
          vault_name: metadata.vault_name,
          message_count: metadata.message_count
        }
      }));
    } catch (error) {
      console.error('Failed to list conversations:', error);
      return [];
    }
  }

  /**
   * Search conversations by query
   */
  async searchConversations(query: string, options?: {
    limit?: number;
    fields?: string[];
  }): Promise<ConversationData[]> {
    try {
      const metadataList = await this.conversationService.searchConversations(query, options?.limit);

      // Convert ConversationMetadata to ConversationData format
      return metadataList.map((metadata: ConversationMetadata) => ({
        id: metadata.id,
        title: metadata.title,
        messages: [], // Empty for search results - messages loaded when conversation is selected
        created: metadata.created,
        updated: metadata.updated,
        metadata: {
          vault_name: metadata.vault_name,
          message_count: metadata.message_count
        }
      }));
    } catch (error) {
      console.error('Failed to search conversations:', error);
      return [];
    }
  }

  /**
   * Get conversation repository for advanced queries
   */
  getConversationRepository(): unknown {
    return this.conversationService.getRepository?.() || this.conversationService;
  }

  /**
   * Get underlying conversation service
   */
  getConversationService(): ConversationServiceLike {
    return this.conversationService;
  }

  /**
   * Count total conversations
   */
  async countConversations(): Promise<number> {
    try {
      return await this.conversationService.count?.() || 0;
    } catch (error) {
      console.error('Failed to count conversations:', error);
      return 0;
    }
  }

  /**
   * Check if conversation exists
   */
  async conversationExists(id: string): Promise<boolean> {
    const conversation = await this.getConversation(id);
    return conversation !== null;
  }
}
