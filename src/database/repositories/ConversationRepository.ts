/**
 * Location: src/database/repositories/ConversationRepository.ts
 *
 * Conversation Repository
 *
 * Manages conversation entity persistence using hybrid JSONL + SQLite storage.
 * Each conversation has its own JSONL file containing metadata and messages.
 *
 * Storage Strategy:
 * - JSONL: conversations/conv_{id}.jsonl (source of truth)
 * - SQLite: conversations table (cache for fast queries)
 * - FTS: Full-text search on title
 *
 * Related Files:
 * - src/database/repositories/interfaces/IConversationRepository.ts - Interface
 * - src/database/repositories/base/BaseRepository.ts - Base class
 * - src/types/storage/HybridStorageTypes.ts - Data types
 */

import { BaseRepository, RepositoryDependencies } from './base/BaseRepository';
import { IConversationRepository, CreateConversationData, UpdateConversationData } from './interfaces/IConversationRepository';
import { ConversationMetadata } from '../../types/storage/HybridStorageTypes';
import { ConversationCreatedEvent, ConversationUpdatedEvent } from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { QueryOptions } from '../interfaces/IStorageAdapter';

/**
 * Conversation repository implementation
 *
 * Stores conversation metadata in SQLite for fast queries.
 * Each conversation has its own JSONL file for messages and events.
 */
export class ConversationRepository
  extends BaseRepository<ConversationMetadata>
  implements IConversationRepository {

  protected readonly tableName = 'conversations';
  protected readonly entityType = 'conversation';

  protected jsonlPath(id: string): string {
    return `conversations/conv_${id}.jsonl`;
  }

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // Abstract method implementations
  // ============================================================================

  protected rowToEntity(row: any): ConversationMetadata {
    return this.rowToConversation(row);
  }

  async getAll(options?: PaginationParams): Promise<PaginatedResult<ConversationMetadata>> {
    return this.getConversations(options);
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  /**
   * Get a conversation by ID
   */
  async getById(id: string): Promise<ConversationMetadata | null> {
    return this.getCachedOrFetch(
      `${this.entityType}:${id}`,
      async () => {
        const row = await this.sqliteCache.queryOne<any>(
          `SELECT * FROM ${this.tableName} WHERE id = ?`,
          [id]
        );
        return row ? this.rowToConversation(row) : null;
      }
    );
  }

  /**
   * Get all conversations with pagination and filtering
   */
  async getConversations(options?: QueryOptions): Promise<PaginatedResult<ConversationMetadata>> {
    const page = options?.page ?? 0;
    const pageSize = Math.min(options?.pageSize ?? 25, 200);
    const sortBy = options?.sortBy ?? 'updated';
    const sortOrder = options?.sortOrder ?? 'desc';
    const includeBranches = options?.includeBranches ?? false;

    // Build WHERE clause
    const filters: string[] = [];
    const params: any[] = [];

    // Exclude branches by default (branches have parentConversationId in metadata)
    if (!includeBranches) {
      filters.push(`(metadataJson IS NULL OR metadataJson NOT LIKE '%"parentConversationId"%')`);
    }

    if (options?.filter) {
      if (options.filter.vaultName) {
        filters.push('vaultName = ?');
        params.push(options.filter.vaultName);
      }
      // Note: workspaceId filter not supported - column not in schema
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    // Count total
    const countResult = await this.sqliteCache.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`,
      params
    );
    const totalItems = countResult?.count ?? 0;

    // Get data
    const rows = await this.sqliteCache.query<any>(
      `SELECT * FROM ${this.tableName} ${whereClause}
       ORDER BY ${sortBy} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, page * pageSize]
    );

    return {
      items: rows.map((r) => this.rowToConversation(r)),
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
      hasNextPage: (page + 1) * pageSize < totalItems,
      hasPreviousPage: page > 0
    };
  }

  /**
   * Search conversations by title using FTS
   */
  async search(query: string): Promise<ConversationMetadata[]> {
    const rows = await this.sqliteCache.searchConversations(query);
    return rows.map((r) => this.rowToConversation(r));
  }

  /**
   * Count conversations matching filter
   */
  async count(filter?: Record<string, unknown>): Promise<number> {
    let whereClause = '';
    const params: any[] = [];

    if (filter) {
      const filters: string[] = [];
      if (filter.vaultName) {
        filters.push('vaultName = ?');
        params.push(filter.vaultName);
      }
      if (filters.length > 0) {
        whereClause = `WHERE ${filters.join(' AND ')}`;
      }
    }

    const result = await this.sqliteCache.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`,
      params
    );
    return result?.count ?? 0;
  }

  // ============================================================================
  // Write Operations
  // ============================================================================

  /**
   * Create a new conversation
   */
  async create(data: CreateConversationData): Promise<string> {
    const id = this.generateId();
    const now = Date.now();

    try {
      // 1. Write metadata event to JSONL (includes settings for branch metadata, etc.)
      const eventData: Omit<ConversationCreatedEvent, 'id' | 'deviceId' | 'timestamp'> = {
        type: 'metadata',
        data: {
          id,
          title: data.title,
          created: data.created ?? now,
          vault: data.vaultName,
          settings: data.metadata  // Store arbitrary metadata (parentConversationId, branchType, etc.)
        }
      };
      await this.writeEvent<ConversationCreatedEvent>(
        this.jsonlPath(id),
        eventData
      );

      // 2. Update SQLite cache
      await this.sqliteCache.run(
        `INSERT INTO ${this.tableName} (id, title, created, updated, vaultName, messageCount, metadataJson)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.title,
          data.created ?? now,
          data.updated ?? now,
          data.vaultName,
          0,
          data.metadata ? JSON.stringify(data.metadata) : null
        ]
      );

      // 3. Invalidate cache
      this.invalidateCache();

      return id;

    } catch (error) {
      console.error('[ConversationRepository] Failed to create conversation:', error);
      throw error;
    }
  }

  /**
   * Update an existing conversation
   */
  async update(id: string, data: UpdateConversationData): Promise<void> {
    try {
      // 1. Write update event to JSONL
      const eventData: Omit<ConversationUpdatedEvent, 'id' | 'deviceId' | 'timestamp'> = {
        type: 'conversation_updated',
        conversationId: id,
        data: {
          title: data.title,
          updated: data.updated ?? Date.now(),
          settings: data.metadata
        }
      };
      await this.writeEvent<ConversationUpdatedEvent>(
        this.jsonlPath(id),
        eventData
      );

      // 2. Update SQLite cache
      const setClauses: string[] = [];
      const params: any[] = [];

      if (data.title !== undefined) {
        setClauses.push('title = ?');
        params.push(data.title);
      }
      // Note: workspaceId and sessionId are not in SQLite schema
      // They are stored in metadataJson if needed
      if (data.metadata !== undefined) {
        setClauses.push('metadataJson = ?');
        params.push(data.metadata ? JSON.stringify(data.metadata) : null);
      }

      // Always update timestamp
      setClauses.push('updated = ?');
      params.push(data.updated ?? Date.now());

      params.push(id);

      await this.sqliteCache.run(
        `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE id = ?`,
        params
      );

      // 3. Invalidate cache
      this.invalidateCache(id);

    } catch (error) {
      console.error('[ConversationRepository] Failed to update conversation:', error);
      throw error;
    }
  }

  /**
   * Delete a conversation
   */
  async delete(id: string): Promise<void> {
    try {
      // No specific delete event - just remove from SQLite
      // Messages are cascaded via foreign key constraint
      await this.sqliteCache.run(`DELETE FROM ${this.tableName} WHERE id = ?`, [id]);

      // Invalidate cache
      this.invalidateCache();

    } catch (error) {
      console.error('[ConversationRepository] Failed to delete conversation:', error);
      throw error;
    }
  }

  /**
   * Increment message count for a conversation
   */
  async incrementMessageCount(id: string): Promise<void> {
    try {
      await this.sqliteCache.run(
        `UPDATE ${this.tableName} SET messageCount = messageCount + 1, updated = ? WHERE id = ?`,
        [Date.now(), id]
      );

      this.invalidateCache(id);

    } catch (error) {
      console.error('[ConversationRepository] Failed to increment message count:', error);
      throw error;
    }
  }

  /**
   * Touch a conversation (update timestamp)
   */
  async touch(id: string, timestamp?: number): Promise<void> {
    try {
      await this.sqliteCache.run(
        `UPDATE ${this.tableName} SET updated = ? WHERE id = ?`,
        [timestamp ?? Date.now(), id]
      );

      this.invalidateCache(id);

    } catch (error) {
      console.error('[ConversationRepository] Failed to touch conversation:', error);
      throw error;
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Convert SQLite row to ConversationMetadata
   */
  private rowToConversation(row: any): ConversationMetadata {
    const metadata = row.metadataJson ? JSON.parse(row.metadataJson) : undefined;
    return {
      id: row.id,
      title: row.title,
      created: row.created,
      updated: row.updated,
      vaultName: row.vaultName,
      messageCount: row.messageCount,
      // workspaceId and sessionId stored in metadata if needed
      workspaceId: metadata?.workspaceId,
      sessionId: metadata?.sessionId,
      metadata
    };
  }
}
