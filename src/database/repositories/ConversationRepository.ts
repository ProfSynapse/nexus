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

import { BaseRepository, DatabaseRow, RepositoryDependencies } from './base/BaseRepository';
import { IConversationRepository, CreateConversationData, UpdateConversationData } from './interfaces/IConversationRepository';
import { ConversationMetadata } from '../../types/storage/HybridStorageTypes';
import { ConversationCreatedEvent, ConversationUpdatedEvent } from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { QueryOptions } from '../interfaces/IStorageAdapter';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRunTrigger(value: unknown): value is 'manual' | 'scheduled' | 'catch_up' {
  return value === 'manual' || value === 'scheduled' || value === 'catch_up';
}

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

  protected rowToEntity(row: DatabaseRow): ConversationMetadata {
    return this.rowToConversation(row as ConversationRow);
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
        const row = await this.sqliteCache.queryOne<ConversationRow>(
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
    const ALLOWED_SORT_COLUMNS = ['id', 'title', 'created', 'updated', 'vaultName', 'messageCount', 'workspaceId', 'sessionId'] as const;
    const ALLOWED_SORT_ORDERS = ['asc', 'desc'] as const;

    const page = options?.page ?? 0;
    const pageSize = Math.min(options?.pageSize ?? 25, 200);
    const requestedSort = options?.sortBy ?? 'updated';
    const requestedOrder = options?.sortOrder ?? 'desc';
    const includeBranches = options?.includeBranches ?? false;

    if (!ALLOWED_SORT_COLUMNS.includes(requestedSort as typeof ALLOWED_SORT_COLUMNS[number])) {
      throw new Error(`Invalid sort column: ${requestedSort}`);
    }
    if (!ALLOWED_SORT_ORDERS.includes(requestedOrder)) {
      throw new Error(`Invalid sort order: ${requestedOrder}`);
    }
    const sortBy = requestedSort;
    const sortOrder = requestedOrder;

    // Build WHERE clause
    const filters: string[] = [];
    const params: Array<string | number | null> = [];

    // Exclude branches by default (branches have parentConversationId in metadata)
    if (!includeBranches) {
      filters.push(`(metadataJson IS NULL OR metadataJson NOT LIKE '%"parentConversationId"%')`);
    }

    if (options?.filter) {
      if (typeof options.filter.vaultName === 'string') {
        filters.push('vaultName = ?');
        params.push(options.filter.vaultName);
      }
      if (typeof options.filter.workspaceId === 'string') {
        filters.push('workspaceId = ?');
        params.push(options.filter.workspaceId);
      }
      if (typeof options.filter.sessionId === 'string') {
        filters.push('sessionId = ?');
        params.push(options.filter.sessionId);
      }
      if (typeof options.filter.workflowId === 'string') {
        filters.push('workflowId = ?');
        params.push(options.filter.workflowId);
      }
      if (typeof options.filter.runKey === 'string') {
        filters.push('runKey = ?');
        params.push(options.filter.runKey);
      }
      if (typeof options.filter.runTrigger === 'string') {
        filters.push('runTrigger = ?');
        params.push(options.filter.runTrigger);
      }
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    // Count total
    const countResult = await this.sqliteCache.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`,
      params
    );
    const totalItems = countResult?.count ?? 0;

    // Get data
    const rows = await this.sqliteCache.query<ConversationRow>(
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
    return rows.map((r) => this.rowToConversation(r as ConversationRow));
  }

  /**
   * Count conversations matching filter
   */
  async count(filter?: Record<string, unknown>): Promise<number> {
    let whereClause = '';
    const params: Array<string | number | null> = [];

    if (filter) {
      const filters: string[] = [];
      if (typeof filter.vaultName === 'string') {
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
      const workspaceId = this.getWorkspaceId(data);
      const sessionId = this.getSessionId(data);
      const workflowId = this.getWorkflowId(data);
      const runTrigger = this.getRunTrigger(data);
      const scheduledFor = this.getScheduledFor(data);
      const runKey = this.getRunKey(data);
      await this.sqliteCache.run(
        `INSERT INTO ${this.tableName} (id, title, created, updated, vaultName, messageCount, metadataJson, workspaceId, sessionId, workflowId, runTrigger, scheduledFor, runKey)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.title,
          data.created ?? now,
          data.updated ?? now,
          data.vaultName,
          0,
          data.metadata ? JSON.stringify(data.metadata) : null,
          workspaceId ?? null,
          sessionId ?? null,
          workflowId ?? null,
          runTrigger ?? null,
          scheduledFor ?? null,
          runKey ?? null
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
      const params: Array<string | number | null> = [];

      if (data.title !== undefined) {
        setClauses.push('title = ?');
        params.push(data.title);
      }
      if (data.workspaceId !== undefined || this.getWorkspaceId(data) !== undefined) {
        setClauses.push('workspaceId = ?');
        params.push(this.getWorkspaceId(data) ?? null);
      }
      if (data.sessionId !== undefined || this.getSessionId(data) !== undefined) {
        setClauses.push('sessionId = ?');
        params.push(this.getSessionId(data) ?? null);
      }
      if (data.workflowId !== undefined || this.getWorkflowId(data) !== undefined) {
        setClauses.push('workflowId = ?');
        params.push(this.getWorkflowId(data) ?? null);
      }
      if (data.runTrigger !== undefined || this.getRunTrigger(data) !== undefined) {
        setClauses.push('runTrigger = ?');
        params.push(this.getRunTrigger(data) ?? null);
      }
      if (data.scheduledFor !== undefined || this.getScheduledFor(data) !== undefined) {
        setClauses.push('scheduledFor = ?');
        params.push(this.getScheduledFor(data) ?? null);
      }
      if (data.runKey !== undefined || this.getRunKey(data) !== undefined) {
        setClauses.push('runKey = ?');
        params.push(this.getRunKey(data) ?? null);
      }
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
  private rowToConversation(row: ConversationRow): ConversationMetadata {
    const metadataRaw: unknown = row.metadataJson ? JSON.parse(row.metadataJson) : undefined;
    const metadata = isRecord(metadataRaw) ? metadataRaw : undefined;
    const chatSettings = metadata && isRecord(metadata.chatSettings) ? metadata.chatSettings : undefined;
    const workspaceId = row.workspaceId ?? (typeof metadata?.workspaceId === 'string' ? metadata.workspaceId : undefined) ?? (typeof chatSettings?.workspaceId === 'string' ? chatSettings.workspaceId : undefined);
    const sessionId = row.sessionId ?? (typeof metadata?.sessionId === 'string' ? metadata.sessionId : undefined) ?? (typeof chatSettings?.sessionId === 'string' ? chatSettings.sessionId : undefined);
    const workflowId = row.workflowId ?? (typeof metadata?.workflowId === 'string' ? metadata.workflowId : undefined);
    const rawRunTrigger = metadata?.runTrigger;
    const runTrigger: ConversationMetadata['runTrigger'] = isRunTrigger(row.runTrigger)
      ? row.runTrigger
      : isRunTrigger(rawRunTrigger)
        ? rawRunTrigger
        : undefined;
    const scheduledFor = row.scheduledFor ?? (typeof metadata?.scheduledFor === 'number' ? metadata.scheduledFor : undefined);
    const runKey = row.runKey ?? (typeof metadata?.runKey === 'string' ? metadata.runKey : undefined);
    return {
      id: row.id,
      title: row.title,
      created: row.created,
      updated: row.updated,
      vaultName: row.vaultName,
      messageCount: row.messageCount,
      workspaceId,
      sessionId,
      workflowId,
      runTrigger,
      scheduledFor,
      runKey,
      metadata
    };
  }

  private getWorkspaceId(data: Partial<ConversationMetadata>): string | undefined {
    return data.workspaceId ?? (data.metadata?.chatSettings as { workspaceId?: string } | undefined)?.workspaceId;
  }

  private getSessionId(data: Partial<ConversationMetadata>): string | undefined {
    return data.sessionId ?? (data.metadata?.chatSettings as { sessionId?: string } | undefined)?.sessionId;
  }

  private getWorkflowId(data: Partial<ConversationMetadata>): string | undefined {
    return data.workflowId ?? (data.metadata?.workflowId as string | undefined);
  }

  private getRunTrigger(data: Partial<ConversationMetadata>): string | undefined {
    return data.runTrigger ?? (data.metadata?.runTrigger as string | undefined);
  }

  private getScheduledFor(data: Partial<ConversationMetadata>): number | undefined {
    return data.scheduledFor ?? (data.metadata?.scheduledFor as number | undefined);
  }

  private getRunKey(data: Partial<ConversationMetadata>): string | undefined {
    return data.runKey ?? (data.metadata?.runKey as string | undefined);
  }
}

interface ConversationRow extends DatabaseRow {
  id: string;
  title: string;
  created: number;
  updated: number;
  vaultName: string;
  messageCount: number;
  metadataJson?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  workflowId?: string | null;
  runTrigger?: string | null;
  scheduledFor?: number | null;
  runKey?: string | null;
}
