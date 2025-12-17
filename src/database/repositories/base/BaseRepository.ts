/**
 * Location: src/database/repositories/base/BaseRepository.ts
 *
 * Base Repository Implementation
 *
 * Provides shared functionality for all entity repositories including:
 * - JSONL event writing
 * - SQLite cache operations
 * - Query cache management
 * - ID generation
 * - Pagination helpers
 *
 * Design Principles:
 * - DRY: Common logic in base class, entity-specific in subclasses
 * - Template Method: Abstract methods for entity-specific operations
 * - Dependency Injection: All dependencies passed via constructor
 *
 * Related Files:
 * - src/database/repositories/interfaces/IRepository.ts - Base interface
 * - src/database/storage/SQLiteCacheManager.ts - SQLite operations
 * - src/database/storage/JSONLWriter.ts - JSONL operations
 */

import { v4 as uuidv4 } from '../../../utils/uuid';
import { IRepository } from '../interfaces/IRepository';
import { PaginatedResult, PaginationParams } from '../../../types/pagination/PaginationTypes';
import { SQLiteCacheManager } from '../../storage/SQLiteCacheManager';
import { JSONLWriter } from '../../storage/JSONLWriter';
import { QueryCache } from '../../optimizations/QueryCache';
import { BaseStorageEvent } from '../../interfaces/StorageEvents';

/**
 * Valid entity types for type-specific cache invalidation
 * Must match the types supported by QueryCache.invalidateByType/invalidateById
 */
export type CacheableEntityType = 'workspace' | 'session' | 'state' | 'conversation' | 'message';

/**
 * Dependencies required by all repositories
 */
export interface RepositoryDependencies {
  /** SQLite cache manager for fast queries */
  sqliteCache: SQLiteCacheManager;

  /** JSONL writer for event sourcing */
  jsonlWriter: JSONLWriter;

  /** Query cache for optimization */
  queryCache: QueryCache;
}

/**
 * Base repository with shared functionality
 *
 * @template T - The entity type this repository manages
 */
export abstract class BaseRepository<T> implements IRepository<T> {
  protected readonly sqliteCache: SQLiteCacheManager;
  protected readonly jsonlWriter: JSONLWriter;
  protected readonly queryCache: QueryCache;

  /**
   * SQLite table name (must be overridden by subclasses)
   */
  protected abstract readonly tableName: string;

  /**
   * Entity type identifier for logging and cache keys
   */
  protected abstract readonly entityType: string;

  /**
   * JSONL file path generator (must be overridden by subclasses)
   * @param id - Entity or workspace ID
   * @returns Relative path to JSONL file
   */
  protected abstract jsonlPath(id: string): string;

  constructor(deps: RepositoryDependencies) {
    this.sqliteCache = deps.sqliteCache;
    this.jsonlWriter = deps.jsonlWriter;
    this.queryCache = deps.queryCache;
  }

  // ============================================================================
  // Abstract Methods (Must be implemented by subclasses)
  // ============================================================================

  /**
   * Convert SQLite row to entity instance
   * @param row - Raw SQLite row data
   * @returns Typed entity instance
   */
  protected abstract rowToEntity(row: any): T;

  /**
   * Get entity by ID (subclasses implement with entity-specific logic)
   */
  abstract getById(id: string): Promise<T | null>;

  /**
   * Get all entities with pagination
   */
  abstract getAll(options?: PaginationParams): Promise<PaginatedResult<T>>;

  /**
   * Create a new entity
   */
  abstract create(data: any): Promise<string>;

  /**
   * Update an existing entity
   */
  abstract update(id: string, data: any): Promise<void>;

  /**
   * Delete an entity
   */
  abstract delete(id: string): Promise<void>;

  /**
   * Count entities
   */
  abstract count(criteria?: Record<string, any>): Promise<number>;

  // ============================================================================
  // Shared Helper Methods
  // ============================================================================

  /**
   * Generate a new UUID for entity IDs
   */
  protected generateId(): string {
    return uuidv4();
  }

  /**
   * Write an event to JSONL file
   *
   * @param path - Relative path to JSONL file
   * @param eventData - Event data (without id, deviceId, timestamp)
   * @returns Complete event with metadata
   */
  protected async writeEvent<E extends BaseStorageEvent>(
    path: string,
    eventData: Omit<E, 'id' | 'deviceId' | 'timestamp'>
  ): Promise<E> {
    try {
      const event = await this.jsonlWriter.appendEvent<E>(path, eventData);
      return event;
    } catch (error) {
      console.error(`[${this.entityType}Repository] Failed to write event:`, error);
      throw error;
    }
  }

  /**
   * Paginated query helper with automatic caching
   *
   * @param baseQuery - SQL query without LIMIT/OFFSET
   * @param countQuery - SQL query to count total items
   * @param options - Pagination options
   * @param params - Query parameters
   * @returns Paginated result
   */
  protected async queryPaginated<R>(
    baseQuery: string,
    countQuery: string,
    options: PaginationParams = {},
    params: any[] = []
  ): Promise<PaginatedResult<R>> {
    const page = options.page ?? 0;
    const pageSize = Math.min(options.pageSize ?? 25, 200);
    const offset = page * pageSize;

    // Get total count
    const countResult = await this.sqliteCache.queryOne<{ count: number }>(countQuery, params);
    const totalItems = countResult?.count ?? 0;
    const totalPages = Math.ceil(totalItems / pageSize);

    // Get paginated results
    const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;
    const items = await this.sqliteCache.query<R>(paginatedQuery, [...params, pageSize, offset]);

    return {
      items,
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages - 1,
      hasPreviousPage: page > 0
    };
  }

  /**
   * Get cached value or execute query function
   *
   * @param cacheKey - Cache key
   * @param queryFn - Function to execute on cache miss
   * @param ttlMs - Optional TTL override
   * @returns Cached or freshly queried result
   */
  protected async getCachedOrFetch<R>(
    cacheKey: string,
    queryFn: () => Promise<R>,
    ttlMs?: number
  ): Promise<R> {
    return this.queryCache.cachedQuery(cacheKey, queryFn, ttlMs);
  }

  /**
   * Check if entity type is cacheable (supports type-specific invalidation)
   *
   * @param type - Entity type to check
   * @returns True if type supports QueryCache.invalidateByType/invalidateById
   */
  private isCacheableEntityType(type: string): type is CacheableEntityType {
    return ['workspace', 'session', 'state', 'conversation', 'message'].includes(type);
  }

  /**
   * Invalidate cache for this entity type
   *
   * @param id - Optional specific entity ID to invalidate
   */
  protected invalidateCache(id?: string): void {
    if (this.isCacheableEntityType(this.entityType)) {
      // Use type-specific invalidation for supported entity types
      if (id) {
        this.queryCache.invalidateById(this.entityType, id);
      } else {
        this.queryCache.invalidateByType(this.entityType);
      }
    } else {
      // Use pattern-based invalidation for other entity types
      if (id) {
        this.queryCache.invalidate(`^${this.entityType}:.*:${id}`);
      } else {
        this.queryCache.invalidate(`^${this.entityType}:`);
      }
    }
  }

  /**
   * Execute multiple operations in a transaction
   *
   * @param fn - Function to execute within transaction
   * @returns Result of the function
   */
  protected async transaction<R>(fn: () => Promise<R>): Promise<R> {
    return this.sqliteCache.transaction(fn);
  }

  /**
   * Log repository operation (disabled by default - enable for debugging)
   *
   * @param operation - Operation name
   * @param details - Optional details
   */
  protected log(_operation: string, _details?: any): void {
  }

  /**
   * Log repository error
   *
   * @param operation - Operation name
   * @param error - Error object
   */
  protected logError(operation: string, error: any): void {
    console.error(`[${this.entityType}Repository] ${operation} failed:`, error);
  }
}
