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
import {
  IMessageRepository,
  CreateMessageData,
  UpdateMessageData,
  ToolCallMessageHistoryOptions
} from './interfaces/IMessageRepository';
import { MessageData, AlternativeMessage } from '../../types/storage/HybridStorageTypes';
import { MessageEvent, MessageUpdatedEvent, MessageDeletedEvent, AlternativeMessageEvent } from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { DatabaseRow, QueryParams } from './base/BaseRepository';

interface MessageRow extends DatabaseRow {
  id: string;
  conversationId: string;
  role: MessageData['role'];
  content: string;
  timestamp: number;
  state?: MessageData['state'];
  sequenceNumber: number;
  toolCallsJson?: string | null;
  toolCallId?: string | null;
  reasoningContent?: string | null;
  alternativesJson?: string | null;
  activeAlternativeIndex?: number | null;
  metadataJson?: string | null;
}

type MessageJSONValue = Record<string, unknown>;

/**
 * Callback signature for message completion observers.
 *
 * Fired when a message reaches state='complete', either via addMessage
 * (created with complete state) or update (transitioned to complete).
 * Used by ConversationEmbeddingWatcher for real-time embedding indexing.
 */
export type MessageCompleteCallback = (message: MessageData) => void;

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

  /** Registered observers for message completion events */
  private messageCompleteCallbacks: MessageCompleteCallback[] = [];

  protected jsonlPath(conversationId: string): string {
    return `conversations/conv_${conversationId}.jsonl`;
  }

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // Observer Registration
  // ============================================================================

  /**
   * Register a callback that fires when a message reaches state='complete'.
   *
   * The callback receives the full MessageData of the completed message.
   * Multiple callbacks can be registered; they fire in registration order.
   * Callbacks are invoked asynchronously (fire-and-forget) so they do not
   * block the write path.
   *
   * @param callback - Function to call when a message completes
   * @returns Unsubscribe function that removes the callback
   */
  onMessageComplete(callback: MessageCompleteCallback): () => void {
    this.messageCompleteCallbacks.push(callback);
    return () => {
      const index = this.messageCompleteCallbacks.indexOf(callback);
      if (index >= 0) {
        this.messageCompleteCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Notify all registered observers that a message has completed.
   * Invoked asynchronously to avoid blocking the write path.
   * Errors in callbacks are caught and logged to prevent cascading failures.
   */
  private notifyMessageComplete(message: MessageData): void {
    for (const callback of this.messageCompleteCallbacks) {
      try {
        callback(message);
      } catch (error) {
        console.error('[MessageRepository] Message complete callback error:', error);
      }
    }
  }

  // ============================================================================
  // Abstract method implementations
  // ============================================================================

  protected rowToEntity(row: MessageRow): MessageData {
    return this.rowToMessage(row);
  }

  async getById(id: string): Promise<MessageData | null> {
    const row = await this.sqliteCache.queryOne<MessageRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id]
    );
    return row ? this.rowToMessage(row) : null;
  }

  getAll(options?: PaginationParams): Promise<PaginatedResult<MessageData>> {
    // Messages don't have a global getAll - they are per conversation
    // Return empty result - use getMessages instead
    return Promise.resolve({
      items: [],
      page: 0,
      pageSize: options?.pageSize ?? 50,
      totalItems: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false
    });
  }

  create(_data: unknown): Promise<string> {
    // Use addMessage with conversationId
    return Promise.reject(new Error('Use addMessage(conversationId, data) instead'));
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
    const rows = await this.sqliteCache.query<MessageRow>(
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
   * Get conversation-wide tool call history using a sequence-number cursor.
   *
   * The cursor represents the oldest already-loaded tool-call message.
   * When omitted, the newest page is returned. When present, older messages
   * with sequenceNumber < cursor are returned.
   */
  async getToolCallMessagesForConversation(
    conversationId: string,
    options?: ToolCallMessageHistoryOptions
  ): Promise<PaginatedResult<MessageData>> {
    const pageSize = Math.max(1, Math.min(options?.pageSize ?? 50, 200));
    const cursorSequenceNumber = this.parseSequenceCursor(options?.cursor);

    const totalResult = await this.sqliteCache.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM ${this.tableName}
       WHERE conversationId = ?
         AND toolCallsJson IS NOT NULL
         AND toolCallsJson != '[]'`,
      [conversationId]
    );
    const totalItems = totalResult?.count ?? 0;

    let newerItemCount = 0;
    if (cursorSequenceNumber !== undefined) {
      const newerResult = await this.sqliteCache.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count
         FROM ${this.tableName}
         WHERE conversationId = ?
           AND toolCallsJson IS NOT NULL
           AND toolCallsJson != '[]'
           AND sequenceNumber >= ?`,
        [conversationId, cursorSequenceNumber]
      );
      newerItemCount = newerResult?.count ?? 0;
    }

    const queryParams: QueryParams = [conversationId];
    let cursorClause = '';
    if (cursorSequenceNumber !== undefined) {
      cursorClause = ' AND sequenceNumber < ?';
      queryParams.push(cursorSequenceNumber);
    }

    const descendingRows = await this.sqliteCache.query<MessageRow>(
      `SELECT *
       FROM ${this.tableName}
       WHERE conversationId = ?
         AND toolCallsJson IS NOT NULL
         AND toolCallsJson != '[]'${cursorClause}
       ORDER BY sequenceNumber DESC
       LIMIT ?`,
      [...queryParams, pageSize]
    );

    const rows = descendingRows.reverse();
    const consumedItems = newerItemCount + rows.length;
    const olderRemaining = Math.max(0, totalItems - consumedItems);

    return {
      items: rows.map((row) => this.rowToMessage(row)),
      page: cursorSequenceNumber === undefined ? 0 : Math.floor(newerItemCount / pageSize),
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
      hasNextPage: olderRemaining > 0,
      hasPreviousPage: newerItemCount > 0,
      nextCursor: olderRemaining > 0 && rows.length > 0 ? String(rows[0].sequenceNumber) : undefined
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
    const rows = await this.sqliteCache.query<MessageRow>(
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

      // 4. Notify observers if message is complete
      const effectiveState = data.state ?? 'complete';
      if (effectiveState === 'complete') {
        this.notifyMessageComplete({
          id,
          conversationId,
          role: data.role,
          content: data.content,
          timestamp: data.timestamp,
          state: 'complete',
          sequenceNumber,
          toolCalls: data.toolCalls,
          toolCallId: data.toolCallId,
          reasoning: data.reasoning,
          alternatives: data.alternatives,
          activeAlternativeIndex: data.activeAlternativeIndex ?? 0,
        });
      }

      return id;

    } catch (error) {
      console.error('[MessageRepository] Failed to add message:', error);
      throw error;
    }
  }

  /**
   * Update an existing message
   * Only content, state, reasoning, and tool call data can be updated.
   *
   * Includes dirty-checking: if none of the supplied fields differ from
   * the current stored values the write is skipped entirely, preventing
   * O(N) redundant JSONL events when callers pass the full message array
   * through ConversationService.updateConversation().
   */
  async update(messageId: string, data: UpdateMessageData): Promise<void> {
    try {
      // Load full current message — used for both change detection and conversationId
      const current = await this.getById(messageId);
      if (!current) {
        throw new Error(`Message ${messageId} not found`);
      }

      // Skip entirely if nothing actually changed (prevents JSONL write amplification)
      if (!this.hasChanges(current, data)) {
        return;
      }

      // 1. Write update event to JSONL
      await this.writeEvent<MessageUpdatedEvent>(
        this.jsonlPath(current.conversationId),
        {
          type: 'message_updated',
          conversationId: current.conversationId,
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
      const params: QueryParams = [];

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

      // 4. Notify observers only on actual state transition to 'complete'
      if (data.state === 'complete' && current.state !== 'complete') {
        const fullMessage = await this.getById(messageId);
        if (fullMessage) {
          this.notifyMessageComplete(fullMessage);
        }
      }

    } catch (error) {
      console.error('[MessageRepository] Failed to update message:', error);
      throw error;
    }
  }

  /**
   * Detect whether any supplied update fields differ from the current stored values.
   * Only checks fields present in the update (undefined = not being updated).
   */
  private hasChanges(current: MessageData, updates: UpdateMessageData): boolean {
    if (updates.content !== undefined) {
      // Normalise null → '' for comparison since SQLite stores empty strings
      const incoming = updates.content ?? '';
      if (incoming !== current.content) return true;
    }
    if (updates.state !== undefined && updates.state !== current.state) {
      return true;
    }
    if (updates.reasoning !== undefined && updates.reasoning !== current.reasoning) {
      return true;
    }
    if (updates.toolCallId !== undefined && updates.toolCallId !== current.toolCallId) {
      return true;
    }
    if (updates.activeAlternativeIndex !== undefined
        && updates.activeAlternativeIndex !== current.activeAlternativeIndex) {
      return true;
    }
    // Serialised comparison for complex objects — conservative (may detect
    // false-positive changes if the caller reshapes tool call objects, but
    // never misses a real change).
    if (updates.toolCalls !== undefined) {
      const currentJson = current.toolCalls ? JSON.stringify(current.toolCalls) : null;
      const updatesJson = updates.toolCalls ? JSON.stringify(updates.toolCalls) : null;
      if (currentJson !== updatesJson) return true;
    }
    if (updates.alternatives !== undefined) {
      const currentJson = current.alternatives ? JSON.stringify(current.alternatives) : null;
      const updatesJson = updates.alternatives ? JSON.stringify(updates.alternatives) : null;
      if (currentJson !== updatesJson) return true;
    }
    return false;
  }

  /**
   * Delete a message from a conversation
   */
  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    try {
      await this.writeEvent<MessageDeletedEvent>(
        this.jsonlPath(conversationId),
        {
          type: 'message_deleted',
          conversationId,
          messageId
        }
      );

      await this.sqliteCache.run(`DELETE FROM ${this.tableName} WHERE id = ?`, [messageId]);

      await this.sqliteCache.run(
        `UPDATE conversations
         SET messageCount = CASE WHEN messageCount > 0 THEN messageCount - 1 ELSE 0 END,
             updated = ?
         WHERE id = ?`,
        [Date.now(), conversationId]
      );

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
  private rowToMessage(row: MessageRow): MessageData {
    let toolCalls: MessageData['toolCalls'];
    let metadata: MessageJSONValue | undefined;
    let alternatives: AlternativeMessage[] | undefined;

    // Defensive JSON parsing — corrupt data shouldn't crash the entire message load
    if (row.toolCallsJson) {
      try {
        toolCalls = this.parseJsonValue<MessageData['toolCalls']>(row.toolCallsJson);
      } catch {
        console.error(`[MessageRepository] Failed to parse toolCallsJson for message ${row.id}`);
        toolCalls = undefined;
      }
    }

    if (row.metadataJson) {
      try {
        metadata = this.parseJsonValue<MessageJSONValue>(row.metadataJson);
      } catch {
        console.error(`[MessageRepository] Failed to parse metadataJson for message ${row.id}`);
        metadata = undefined;
      }
    }

    if (row.alternativesJson) {
      try {
        alternatives = this.parseJsonValue<AlternativeMessage[]>(row.alternativesJson);
      } catch {
        console.error(`[MessageRepository] Failed to parse alternativesJson for message ${row.id}`);
        alternatives = undefined;
      }
    }

    return {
      id: row.id,
      conversationId: row.conversationId,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      state: row.state ?? 'complete',
      sequenceNumber: row.sequenceNumber,
      toolCalls,
      toolCallId: row.toolCallId ?? undefined,
      reasoning: row.reasoningContent ?? undefined,
      metadata,
      alternatives,
      activeAlternativeIndex: row.activeAlternativeIndex ?? 0
    };
  }

  private parseSequenceCursor(cursor?: string): number | undefined {
    if (cursor === undefined || cursor.trim() === '') {
      return undefined;
    }

    const parsed = Number.parseInt(cursor, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`[MessageRepository] Invalid sequence cursor: ${cursor}`);
    }

    return parsed;
  }

  private parseJsonValue<T>(json: string): T | undefined {
    try {
      return JSON.parse(json) as T;
    } catch {
      return undefined;
    }
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
