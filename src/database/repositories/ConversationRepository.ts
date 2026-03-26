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

interface ConversationRow {
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

type ConversationSortColumn = 'id' | 'title' | 'created' | 'updated' | 'vaultName' | 'messageCount' | 'workspaceId' | 'sessionId';
type ConversationSortOrder = 'asc' | 'desc';

interface ConversationChatSettings extends Record<string, unknown> {
  workspaceId?: string;
  sessionId?: string;
}

interface ConversationMetadataRecord extends Record<string, unknown> {
  chatSettings?: ConversationChatSettings;
  workspaceId?: string;
  sessionId?: string;
  workflowId?: string;
  runTrigger?: string;
  scheduledFor?: number;
  runKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAllowedSortColumn(value: string): value is ConversationSortColumn {
  return value === 'id' ||
    value === 'title' ||
    value === 'created' ||
    value === 'updated' ||
    value === 'vaultName' ||
    value === 'messageCount' ||
    value === 'workspaceId' ||
    value === 'sessionId';
}

function isAllowedSortOrder(value: string): value is ConversationSortOrder {
  return value === 'asc' || value === 'desc';
}

function parseConversationMetadata(metadataJson: string | null | undefined): ConversationMetadataRecord | undefined {
  if (!metadataJson) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(metadataJson);
  return isRecord(parsed) ? parsed : undefined;
}

function isConversationChatSettings(value: unknown): value is ConversationChatSettings {
  return isRecord(value) &&
    (value.workspaceId === undefined || isString(value.workspaceId)) &&
    (value.sessionId === undefined || isString(value.sessionId));
}

function isConversationRow(value: unknown): value is ConversationRow {
  return isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isNumber(value.created) &&
    isNumber(value.updated) &&
    isString(value.vaultName) &&
    isNumber(value.messageCount) &&
    (value.metadataJson === undefined || value.metadataJson === null || isString(value.metadataJson)) &&
    (value.workspaceId === undefined || value.workspaceId === null || isString(value.workspaceId)) &&
    (value.sessionId === undefined || value.sessionId === null || isString(value.sessionId)) &&
    (value.workflowId === undefined || value.workflowId === null || isString(value.workflowId)) &&
    (value.runTrigger === undefined || value.runTrigger === null || isString(value.runTrigger)) &&
    (value.scheduledFor === undefined || value.scheduledFor === null || isNumber(value.scheduledFor)) &&
    (value.runKey === undefined || value.runKey === null || isString(value.runKey));
}

function getConversationChatSettings(metadata: Record<string, unknown> | undefined): ConversationChatSettings | undefined {
  if (!metadata || !isConversationChatSettings(metadata.chatSettings)) {
    return undefined;
  }

  return metadata.chatSettings;
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

  protected rowToEntity(row: unknown): ConversationMetadata {
    if (!isConversationRow(row)) {
      throw new Error('Invalid conversation row');
    }

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
    const page = options?.page ?? 0;
    const pageSize = Math.min(options?.pageSize ?? 25, 200);
    const requestedSort = options?.sortBy ?? 'updated';
    const requestedOrder = options?.sortOrder ?? 'desc';
    const includeBranches = options?.includeBranches ?? false;

    if (!isAllowedSortColumn(requestedSort)) {
      throw new Error(`Invalid sort column: ${requestedSort}`);
    }
    if (!isAllowedSortOrder(requestedOrder)) {
      throw new Error(`Invalid sort order: ${String(requestedOrder)}`);
    }
    const sortBy: ConversationSortColumn = requestedSort;
    const sortOrder: ConversationSortOrder = requestedOrder;

    // Build WHERE clause
    const filters: string[] = [];
    const params: Array<string | number | null> = [];

    // Exclude branches by default (branches have parentConversationId in metadata)
    if (!includeBranches) {
      filters.push(`(metadataJson IS NULL OR metadataJson NOT LIKE '%"parentConversationId"%')`);
    }

    if (options?.filter) {
      if (options.filter.vaultName) {
        filters.push('vaultName = ?');
        params.push(options.filter.vaultName);
      }
      if (options.filter.workspaceId) {
        filters.push('workspaceId = ?');
        params.push(options.filter.workspaceId);
      }
      if (options.filter.sessionId) {
        filters.push('sessionId = ?');
        params.push(options.filter.sessionId);
      }
      if (options.filter.workflowId) {
        filters.push('workflowId = ?');
        params.push(options.filter.workflowId);
      }
      if (options.filter.runKey) {
        filters.push('runKey = ?');
        params.push(options.filter.runKey);
      }
      if (options.filter.runTrigger) {
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
    return rows
      .filter(isConversationRow)
      .map((r) => this.rowToConversation(r));
  }

  /**
   * Count conversations matching filter
   */
  async count(filter?: Record<string, unknown>): Promise<number> {
    let whereClause = '';
    const params: Array<string | number | null> = [];

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
    const metadata = parseConversationMetadata(row.metadataJson);
    const chatSettings = getConversationChatSettings(metadata);
    const workspaceId = row.workspaceId ?? metadata?.workspaceId ?? chatSettings?.workspaceId;
    const sessionId = row.sessionId ?? metadata?.sessionId ?? chatSettings?.sessionId;
    const workflowId = row.workflowId ?? metadata?.workflowId;
    const runTrigger = row.runTrigger ?? metadata?.runTrigger;
    const scheduledFor = row.scheduledFor ?? metadata?.scheduledFor;
    const runKey = row.runKey ?? metadata?.runKey;
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
    const chatSettings = getConversationChatSettings(data.metadata);
    return data.workspaceId ?? chatSettings?.workspaceId;
  }

  private getSessionId(data: Partial<ConversationMetadata>): string | undefined {
    const chatSettings = getConversationChatSettings(data.metadata);
    return data.sessionId ?? chatSettings?.sessionId;
  }

  private getWorkflowId(data: Partial<ConversationMetadata>): string | undefined {
    return data.workflowId ?? (isRecord(data.metadata) && isString(data.metadata.workflowId) ? data.metadata.workflowId : undefined);
  }

  private getRunTrigger(data: Partial<ConversationMetadata>): string | undefined {
    return data.runTrigger ?? (isRecord(data.metadata) && isString(data.metadata.runTrigger) ? data.metadata.runTrigger : undefined);
  }

  private getScheduledFor(data: Partial<ConversationMetadata>): number | undefined {
    return data.scheduledFor ?? (isRecord(data.metadata) && typeof data.metadata.scheduledFor === 'number' ? data.metadata.scheduledFor : undefined);
  }

  private getRunKey(data: Partial<ConversationMetadata>): string | undefined {
    return data.runKey ?? (isRecord(data.metadata) && isString(data.metadata.runKey) ? data.metadata.runKey : undefined);
  }
}
