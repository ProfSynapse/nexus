/**
 * Location: src/database/repositories/MessageRepository.ts
 *
 * Message Repository
 *
 * Manages message persistence in conversation JSONL files.
 * Messages are stored in OpenAI fine-tuning format with auto-incrementing sequence numbers.
 *
 * Storage Strategy:
 * - JSONL: conversations/conv_{conversationId}.jsonl (source of truth)
 * - SQLite: messages table (cache for fast queries and pagination)
 * - Ordering: By sequenceNumber (auto-incremented)
 *
 * Related Files:
 * - src/database/repositories/interfaces/IMessageRepository.ts - Interface
 * - src/database/repositories/base/BaseRepository.ts - Base class
 * - src/types/storage/HybridStorageTypes.ts - Data types
 */

import { BaseRepository, RepositoryDependencies } from './base/BaseRepository';
import { IMessageRepository, CreateMessageData, UpdateMessageData } from './interfaces/IMessageRepository';
import { MessageData, AlternativeMessage } from '../../types/storage/HybridStorageTypes';
import { MessageEvent, MessageUpdatedEvent, AlternativeMessageEvent } from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';

/**
 * Message repository implementation
 *
 * Messages are appended to conversation JSONL files in OpenAI format.
 * Each message has an auto-incrementing sequence number for ordering.
 */
export class MessageRepository
  extends BaseRepository<MessageData>
  implements IMessageRepository {

  protected readonly tableName = 'messages';
  protected readonly entityType = 'message';

  protected jsonlPath(conversationId: string): string {
    return `conversations/conv_${conversationId}.jsonl`;
  }

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // Abstract method implementations
  // ============================================================================

  protected rowToEntity(row: any): MessageData {
    return this.rowToMessage(row);
  }

  async getById(id: string): Promise<MessageData | null> {
    const row = await this.sqliteCache.queryOne<any>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id]
    );
    return row ? this.rowToMessage(row) : null;
  }

  async getAll(options?: PaginationParams): Promise<PaginatedResult<MessageData>> {
    // Messages don't have a global getAll - they are per conversation
    // Return empty result - use getMessages instead
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

  async create(data: any): Promise<string> {
    // Use addMessage with conversationId
    throw new Error('Use addMessage(conversationId, data) instead');
  }

  async delete(id: string): Promise<void> {
    await this.sqliteCache.run(`DELETE FROM ${this.tableName} WHERE id = ?`, [id]);
    this.invalidateCache();
  }

  async count(criteria?: Record<string, unknown>): Promise<number> {
    if (criteria?.conversationId && typeof criteria.conversationId === 'string') {
      return this.countMessages(criteria.conversationId);
    }
    const result = await this.sqliteCache.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.tableName}`,
      []
    );
    return result?.count ?? 0;
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  /**
   * Get messages for a conversation (paginated, ordered by sequence number)
   */
  async getMessages(
    conversationId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MessageData>> {
    const page = options?.page ?? 0;
    const pageSize = Math.min(options?.pageSize ?? 50, 200);

    // Count total
    const countResult = await this.sqliteCache.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.tableName} WHERE conversationId = ?`,
      [conversationId]
    );
    const totalItems = countResult?.count ?? 0;

    // Get data (ordered by sequence number)
    const rows = await this.sqliteCache.query<any>(
      `SELECT * FROM ${this.tableName} WHERE conversationId = ?
       ORDER BY sequenceNumber ASC
       LIMIT ? OFFSET ?`,
      [conversationId, pageSize, page * pageSize]
    );

    return {
      items: rows.map((r) => this.rowToMessage(r)),
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
      hasNextPage: (page + 1) * pageSize < totalItems,
      hasPreviousPage: page > 0
    };
  }

  /**
   * Count messages in a conversation
   */
  async countMessages(conversationId: string): Promise<number> {
    const result = await this.sqliteCache.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.tableName} WHERE conversationId = ?`,
      [conversationId]
    );
    return result?.count ?? 0;
  }

  /**
   * Get the next sequence number for a conversation
   */
  async getNextSequenceNumber(conversationId: string): Promise<number> {
    const result = await this.sqliteCache.queryOne<{ maxSeq: number }>(
      `SELECT MAX(sequenceNumber) as maxSeq FROM ${this.tableName} WHERE conversationId = ?`,
      [conversationId]
    );
    return (result?.maxSeq ?? -1) + 1;
  }

  /**
   * Get messages within a sequence number range for a conversation.
   * Leverages the idx_messages_sequence index on (conversationId, sequenceNumber).
   *
   * @param conversationId - The conversation to query
   * @param startSeq - Inclusive lower bound of the sequence number range
   * @param endSeq - Inclusive upper bound of the sequence number range
   * @returns Messages within the range, ordered by sequence number ascending
   */
  async getMessagesBySequenceRange(
    conversationId: string,
    startSeq: number,
    endSeq: number
  ): Promise<MessageData[]> {
    const rows = await this.sqliteCache.query<any>(
      `SELECT * FROM ${this.tableName}
       WHERE conversationId = ?
         AND sequenceNumber >= ?
         AND sequenceNumber <= ?
       ORDER BY sequenceNumber ASC`,
      [conversationId, startSeq, endSeq]
    );

    return rows.map((r) => this.rowToMessage(r));
  }

  // ============================================================================
  // Write Operations
  // ============================================================================

  /**
   * Add a new message to a conversation
   * Sequence number is auto-incremented
   */
  async addMessage(conversationId: string, data: CreateMessageData): Promise<string> {
    const id = data.id || this.generateId();

    try {
      // Get next sequence number
      const sequenceNumber = await this.getNextSequenceNumber(conversationId);

      // 1. Write message event to conversation JSONL
      await this.writeEvent<MessageEvent>(
        this.jsonlPath(conversationId),
        {
          type: 'message',
          conversationId,
          data: {
            id,
            role: data.role,
            content: data.content,
            tool_calls: data.toolCalls?.map(tc => ({
              id: tc.id,
              type: tc.type || 'function',
              function: tc.function,
              // Persist extras so tool bubbles can be reconstructed after reload
              name: tc.name,
              parameters: tc.parameters,
              result: tc.result,
              success: tc.success,
              error: tc.error,
              executionTime: tc.executionTime
            })),
            tool_call_id: data.toolCallId,
            state: data.state,
            sequenceNumber,
            // Branching support
            alternatives: this.convertAlternativesToEvent(data.alternatives),
            activeAlternativeIndex: data.activeAlternativeIndex ?? 0
          }
        }
      );

      // 2. Update SQLite cache
      await this.sqliteCache.run(
        `INSERT INTO ${this.tableName}
         (id, conversationId, role, content, timestamp, state, toolCallsJson, toolCallId, sequenceNumber, reasoningContent, alternativesJson, activeAlternativeIndex)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          conversationId,
          data.role,
          data.content,
          data.timestamp,
          data.state ?? 'complete',
          data.toolCalls ? JSON.stringify(data.toolCalls) : null,
          data.toolCallId ?? null,
          sequenceNumber,
          data.reasoning ?? null,
          data.alternatives ? JSON.stringify(data.alternatives) : null,
          data.activeAlternativeIndex ?? 0
        ]
      );

      // 3. Invalidate cache
      this.invalidateCache();

      return id;

    } catch (error) {
      console.error('[MessageRepository] Failed to add message:', error);
      throw error;
    }
  }

  /**
   * Update an existing message
   * Only content, state, reasoning, and tool call data can be updated
   */
  async update(messageId: string, data: UpdateMessageData): Promise<void> {
    try {
      // Get message to find conversation ID
      const message = await this.sqliteCache.queryOne<any>(
        `SELECT conversationId FROM ${this.tableName} WHERE id = ?`,
        [messageId]
      );

      if (!message) {
        throw new Error(`Message ${messageId} not found`);
      }

      // 1. Write update event to JSONL
      await this.writeEvent<MessageUpdatedEvent>(
        this.jsonlPath(message.conversationId),
        {
          type: 'message_updated',
          conversationId: message.conversationId,
          messageId,
          data: {
            content: data.content ?? undefined,
            state: data.state,
            reasoning: data.reasoning,
            // Persist full tool call data including results so tool bubbles can be reconstructed
            tool_calls: data.toolCalls?.map(tc => ({
              id: tc.id,
              type: tc.type || 'function',
              function: tc.function,
              name: tc.name,
              parameters: tc.parameters,
              result: tc.result,
              success: tc.success,
              error: tc.error
            })),
            tool_call_id: data.toolCallId ?? undefined,
            // Branching support
            alternatives: this.convertAlternativesToEvent(data.alternatives),
            activeAlternativeIndex: data.activeAlternativeIndex
          }
        }
      );

      // 2. Update SQLite cache
      const setClauses: string[] = [];
      const params: any[] = [];

      if (data.content !== undefined) {
        setClauses.push('content = ?');
        params.push(data.content);
      }
      if (data.state !== undefined) {
        setClauses.push('state = ?');
        params.push(data.state);
      }
      if (data.reasoning !== undefined) {
        setClauses.push('reasoningContent = ?');
        params.push(data.reasoning);
      }
      if (data.toolCalls !== undefined) {
        setClauses.push('toolCallsJson = ?');
        params.push(data.toolCalls ? JSON.stringify(data.toolCalls) : null);
      }
      if (data.toolCallId !== undefined) {
        setClauses.push('toolCallId = ?');
        params.push(data.toolCallId);
      }
      if (data.alternatives !== undefined) {
        setClauses.push('alternativesJson = ?');
        params.push(data.alternatives ? JSON.stringify(data.alternatives) : null);
      }
      if (data.activeAlternativeIndex !== undefined) {
        setClauses.push('activeAlternativeIndex = ?');
        params.push(data.activeAlternativeIndex);
      }

      if (setClauses.length > 0) {
        params.push(messageId);
        await this.sqliteCache.run(
          `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE id = ?`,
          params
        );
      }

      // 3. Invalidate cache
      this.invalidateCache();

    } catch (error) {
      console.error('[MessageRepository] Failed to update message:', error);
      throw error;
    }
  }

  /**
   * Delete a message from a conversation
   */
  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    try {
      // No specific delete event - just remove from SQLite
      await this.sqliteCache.run(`DELETE FROM ${this.tableName} WHERE id = ?`, [messageId]);

      // Invalidate cache
      this.invalidateCache();

    } catch (error) {
      console.error('[MessageRepository] Failed to delete message:', error);
      throw error;
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Convert SQLite row to MessageData
   */
  private rowToMessage(row: any): MessageData {
    return {
      id: row.id,
      conversationId: row.conversationId,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      state: row.state ?? 'complete',
      sequenceNumber: row.sequenceNumber,
      toolCalls: row.toolCallsJson ? JSON.parse(row.toolCallsJson) : undefined,
      toolCallId: row.toolCallId ?? undefined,
      reasoning: row.reasoningContent ?? undefined,
      metadata: row.metadataJson ? JSON.parse(row.metadataJson) : undefined,
      alternatives: row.alternativesJson ? JSON.parse(row.alternativesJson) : undefined,
      activeAlternativeIndex: row.activeAlternativeIndex ?? 0
    };
  }

  /**
   * Convert AlternativeMessage[] to AlternativeMessageEvent[] for JSONL storage
   */
  private convertAlternativesToEvent(alternatives?: AlternativeMessage[]): AlternativeMessageEvent[] | undefined {
    if (!alternatives || alternatives.length === 0) {
      return undefined;
    }
    return alternatives.map(alt => ({
      id: alt.id,
      content: alt.content,
      timestamp: alt.timestamp,
      tool_calls: alt.toolCalls?.map(tc => ({
        id: tc.id,
        type: tc.type || 'function',
        function: tc.function,
        // Persist extras so tool bubbles can be reconstructed after reload
        name: tc.name,
        parameters: tc.parameters,
        result: tc.result,
        success: tc.success,
        error: tc.error,
        executionTime: tc.executionTime
      })),
      reasoning: alt.reasoning,
      state: alt.state
    }));
  }
}
