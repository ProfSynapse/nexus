/**
 * Location: src/database/repositories/interfaces/IMessageRepository.ts
 *
 * Message Repository Interface
 *
 * Defines the contract for message persistence operations.
 * Messages are stored in conversation JSONL files in OpenAI format.
 *
 * Related Files:
 * - src/database/repositories/MessageRepository.ts - Implementation
 * - src/types/storage/HybridStorageTypes.ts - Data types
 */

import { PaginatedResult, PaginationParams } from '../../../types/pagination/PaginationTypes';
import { MessageData, AlternativeMessage } from '../../../types/storage/HybridStorageTypes';

/**
 * Data for creating a new message
 */
export interface CreateMessageData extends Omit<MessageData, 'id' | 'conversationId' | 'sequenceNumber'> {
  /**
   * Optional custom message ID (used for streaming placeholders so UI/storage IDs stay in sync)
   */
  id?: string;
}

/**
 * Data for updating an existing message
 * Only content, state, reasoning, tool call data, and alternatives can be updated
 */
export interface UpdateMessageData {
  content?: string | null;
  state?: 'draft' | 'streaming' | 'complete' | 'aborted' | 'invalid';
  reasoning?: string;
  toolCalls?: MessageData['toolCalls'];
  toolCallId?: string | null;
  /** Alternative responses for branching */
  alternatives?: AlternativeMessage[];
  /** Which alternative is active: 0 = original, 1+ = alternative index + 1 */
  activeAlternativeIndex?: number;
}

/**
 * Message repository interface
 */
export interface IMessageRepository {
  /**
   * Get messages for a conversation (paginated, ordered by sequence number)
   */
  getMessages(conversationId: string, options?: PaginationParams): Promise<PaginatedResult<MessageData>>;

  /**
   * Add a new message to a conversation
   * Sequence number is auto-incremented
   */
  addMessage(conversationId: string, data: CreateMessageData): Promise<string>;

  /**
   * Update an existing message
   * Only content, state, and reasoning can be updated
   */
  update(messageId: string, data: UpdateMessageData): Promise<void>;

  /**
   * Delete a message from a conversation
   */
  deleteMessage(conversationId: string, messageId: string): Promise<void>;

  /**
   * Get the next sequence number for a conversation
   */
  getNextSequenceNumber(conversationId: string): Promise<number>;

  /**
   * Count messages in a conversation
   */
  countMessages(conversationId: string): Promise<number>;

  /**
   * Get messages within a sequence number range for a conversation.
   * Returns messages ordered by sequenceNumber ASC where
   * sequenceNumber >= startSeq AND sequenceNumber <= endSeq.
   *
   * Used by ConversationWindowRetriever to fetch windowed context
   * around a matched QA pair.
   *
   * @param conversationId - The conversation to query
   * @param startSeq - Inclusive lower bound of the sequence number range
   * @param endSeq - Inclusive upper bound of the sequence number range
   * @returns Messages within the range, ordered by sequence number
   */
  getMessagesBySequenceRange(
    conversationId: string,
    startSeq: number,
    endSeq: number
  ): Promise<MessageData[]>;
}
