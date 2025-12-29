/**
 * Location: src/database/repositories/interfaces/IConversationRepository.ts
 *
 * Conversation Repository Interface
 *
 * Defines the contract for conversation persistence operations.
 * Follows Interface Segregation Principle - only conversation-specific methods.
 *
 * Related Files:
 * - src/database/repositories/ConversationRepository.ts - Implementation
 * - src/types/storage/HybridStorageTypes.ts - Data types
 */

import { PaginatedResult, PaginationParams } from '../../../types/pagination/PaginationTypes';
import { ConversationMetadata } from '../../../types/storage/HybridStorageTypes';
import { QueryOptions } from '../../interfaces/IStorageAdapter';

/**
 * Data for creating a new conversation
 */
export interface CreateConversationData extends Omit<ConversationMetadata, 'id' | 'messageCount'> {
  // All fields from ConversationMetadata except id and messageCount
}

/**
 * Data for updating an existing conversation
 */
export interface UpdateConversationData extends Partial<ConversationMetadata> {
  // Partial updates allowed for all fields
}

/**
 * Conversation repository interface
 */
export interface IConversationRepository {
  /**
   * Get a conversation by ID
   */
  getById(id: string): Promise<ConversationMetadata | null>;

  /**
   * Get all conversations with pagination and filtering
   */
  getConversations(options?: QueryOptions): Promise<PaginatedResult<ConversationMetadata>>;

  /**
   * Create a new conversation
   */
  create(data: CreateConversationData): Promise<string>;

  /**
   * Update an existing conversation
   */
  update(id: string, data: UpdateConversationData): Promise<void>;

  /**
   * Delete a conversation
   */
  delete(id: string): Promise<void>;

  /**
   * Search conversations by title
   */
  search(query: string): Promise<ConversationMetadata[]>;

  /**
   * Increment message count for a conversation
   */
  incrementMessageCount(id: string): Promise<void>;

  /**
   * Touch a conversation (update timestamp)
   */
  touch(id: string, timestamp?: number): Promise<void>;

  /**
   * Count conversations matching filter
   */
  count(filter?: Record<string, unknown>): Promise<number>;
}
