/**
 * Location: /src/database/optimizations/QueryCache.ts
 *
 * Query cache with TTL and pattern-based invalidation.
 * Optimizes expensive read operations by caching results with configurable lifetimes.
 *
 * Design Principles:
 * - Time-based expiration (TTL) for cache freshness
 * - Pattern-based invalidation for bulk updates
 * - Type-specific invalidation for targeted cache clearing
 * - LRU-style eviction when hitting max size
 * - Cache statistics for monitoring and optimization
 *
 * Related Files:
 * - /src/database/storage/SQLiteCacheManager.ts - Uses query cache for read operations
 * - /src/database/sync/SyncCoordinator.ts - Invalidates cache after sync
 * - /src/database/services/cache/CacheManager.ts - Existing cache infrastructure
 */

/**
 * Internal cache entry structure
 */
export interface CacheEntry<T> {
  /** Cached query result */
  result: T;
  /** Timestamp when entry expires (Unix ms) */
  expires: number;
  /** Timestamp when entry was created (Unix ms) */
  createdAt: number;
}

/**
 * Cache performance statistics
 */
export interface CacheStats {
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Current cache size */
  size: number;
  /** Creation timestamp of oldest entry (null if empty) */
  oldestEntry: number | null;
}

/**
 * Query cache with TTL-based expiration and pattern-based invalidation.
 *
 * Provides automatic caching for expensive queries with configurable lifetimes.
 * Supports bulk invalidation via patterns or entity types.
 *
 * Features:
 * - Automatic TTL-based expiration
 * - LRU eviction when reaching max size
 * - Pattern-based invalidation (regex)
 * - Type-specific invalidation (workspace, session, etc.)
 * - Hit/miss statistics for monitoring
 * - Cleanup of expired entries
 *
 * @example Basic usage
 * ```typescript
 * const cache = new QueryCache({ defaultTTL: 60000 }); // 1 minute default
 *
 * // Cache a query result
 * const result = await cache.cachedQuery(
 *   'workspace:get:abc123',
 *   async () => db.getWorkspace('abc123'),
 *   30000 // 30 second TTL
 * );
 * ```
 *
 * @example Pattern invalidation
 * ```typescript
 * // Invalidate all workspace queries
 * cache.invalidate('^workspace:');
 *
 * // Invalidate specific workspace
 * cache.invalidate('workspace:.*:abc123');
 * ```
 */
export class QueryCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private hits = 0;
  private misses = 0;
  private maxSize: number;
  private defaultTTL: number;

  /**
   * Create a new query cache
   *
   * @param options.maxSize - Maximum number of entries (default: 1000)
   * @param options.defaultTTL - Default TTL in milliseconds (default: 60000)
   */
  constructor(options: { maxSize?: number; defaultTTL?: number } = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.defaultTTL = options.defaultTTL ?? 60000; // 1 minute default
  }

  /**
   * Get or compute a cached value.
   *
   * If the key exists and hasn't expired, returns cached value.
   * Otherwise executes queryFn and caches the result.
   *
   * @param key - Cache key (should be unique per query)
   * @param queryFn - Function to execute on cache miss
   * @param ttlMs - Optional TTL override (uses defaultTTL if not specified)
   * @returns Cached or newly computed result
   */
  async cachedQuery<T>(
    key: string,
    queryFn: () => Promise<T>,
    ttlMs?: number
  ): Promise<T> {
    const ttl = ttlMs ?? this.defaultTTL;
    const now = Date.now();

    // Check cache
    const cached = this.cache.get(key);
    if (cached && cached.expires > now) {
      this.hits++;
      return cached.result as T;
    }

    // Cache miss - execute query
    this.misses++;
    const result = await queryFn();

    // Store in cache
    this.set(key, result, ttl);

    return result;
  }

  /**
   * Set a cache entry directly.
   *
   * Useful for proactive caching or updating cache after mutations.
   *
   * @param key - Cache key
   * @param result - Value to cache
   * @param ttlMs - Optional TTL override
   */
  set<T>(key: string, result: T, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTTL;
    const now = Date.now();

    // Evict if at max size
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      result,
      expires: now + ttl,
      createdAt: now
    });
  }

  /**
   * Get a cache entry without computing.
   *
   * Returns undefined if key doesn't exist or entry has expired.
   *
   * @param key - Cache key
   * @returns Cached value or undefined
   */
  get<T>(key: string): T | undefined {
    const now = Date.now();
    const cached = this.cache.get(key);

    if (cached && cached.expires > now) {
      this.hits++;
      return cached.result as T;
    }

    if (cached) {
      // Expired - remove it
      this.cache.delete(key);
    }

    this.misses++;
    return undefined;
  }

  /**
   * Invalidate cache entries matching a pattern.
   *
   * Supports both string patterns (with * wildcards) and RegExp.
   *
   * @param pattern - Pattern to match (string with * wildcards or RegExp)
   * @returns Number of entries invalidated
   *
   * @example
   * ```typescript
   * // Invalidate all workspace queries
   * cache.invalidate('workspace:*');
   *
   * // Invalidate specific workspace
   * cache.invalidate(/workspace:get:abc123/);
   * ```
   */
  invalidate(pattern: string | RegExp): number {
    let invalidated = 0;
    const regex = typeof pattern === 'string'
      ? new RegExp(pattern.replace(/\*/g, '.*'))
      : pattern;

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        invalidated++;
      }
    }

    return invalidated;
  }

  /**
   * Invalidate a specific cache key.
   *
   * @param key - Cache key to invalidate
   * @returns True if key was found and removed
   */
  invalidateKey(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Invalidate all entries for a specific entity type.
   *
   * Convenience method for type-specific invalidation.
   *
   * @param type - Entity type to invalidate
   * @returns Number of entries invalidated
   *
   * @example
   * ```typescript
   * // Invalidate all workspace queries
   * cache.invalidateByType('workspace');
   *
   * // Invalidate all conversation queries
   * cache.invalidateByType('conversation');
   * ```
   */
  invalidateByType(type: 'workspace' | 'session' | 'state' | 'conversation' | 'message' | 'project' | 'task'): number {
    return this.invalidate(`^${type}:`);
  }

  /**
   * Invalidate all entries for a specific entity ID.
   *
   * @param type - Entity type
   * @param id - Entity ID
   * @returns Number of entries invalidated
   *
   * @example
   * ```typescript
   * // Invalidate all queries for workspace abc123
   * cache.invalidateById('workspace', 'abc123');
   * ```
   */
  invalidateById(
    type: 'workspace' | 'session' | 'state' | 'conversation' | 'message' | 'project' | 'task',
    id: string
  ): number {
    return this.invalidate(new RegExp(`^${type}:(?:.*:)?${id}$`));
  }

  /**
   * Clear entire cache.
   *
   * Removes all entries and resets statistics.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Remove expired entries.
   *
   * Performs garbage collection on expired cache entries.
   * Should be called periodically to prevent memory leaks.
   *
   * @returns Number of entries removed
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expires <= now) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Evict oldest entry (LRU-style).
   *
   * Internal method called when cache reaches max size.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Get cache statistics.
   *
   * @returns Cache performance metrics
   */
  getStats(): CacheStats {
    let oldestEntry: number | null = null;

    for (const entry of this.cache.values()) {
      if (oldestEntry === null || entry.createdAt < oldestEntry) {
        oldestEntry = entry.createdAt;
      }
    }

    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      oldestEntry
    };
  }

  /**
   * Get hit rate percentage.
   *
   * @returns Hit rate as percentage (0-100)
   */
  getHitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? (this.hits / total) * 100 : 0;
  }

  // ============================================================================
  // Static Helper Methods for Cache Key Generation
  // ============================================================================

  /**
   * Generate cache key for workspace queries.
   *
   * @param id - Workspace ID (omit for list queries)
   * @param queryType - Type of query (default: 'get')
   * @returns Formatted cache key
   *
   * @example
   * ```typescript
   * QueryCache.workspaceKey('abc123', 'get'); // 'workspace:get:abc123'
   * QueryCache.workspaceKey(undefined, 'list'); // 'workspace:list:all'
   * ```
   */
  static workspaceKey(id?: string, queryType = 'get'): string {
    return id ? `workspace:${queryType}:${id}` : `workspace:${queryType}:all`;
  }

  /**
   * Generate cache key for session queries.
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Session ID (omit for list queries)
   * @param queryType - Type of query (default: 'get')
   * @returns Formatted cache key
   */
  static sessionKey(workspaceId: string, sessionId?: string, queryType = 'get'): string {
    return sessionId
      ? `session:${queryType}:${workspaceId}:${sessionId}`
      : `session:${queryType}:${workspaceId}:all`;
  }

  /**
   * Generate cache key for state queries.
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Parent session ID (omit for list queries)
   * @param queryType - Type of query (default: 'get')
   * @returns Formatted cache key
   */
  static stateKey(workspaceId: string, sessionId?: string, queryType = 'get'): string {
    return sessionId
      ? `state:${queryType}:${workspaceId}:${sessionId}`
      : `state:${queryType}:${workspaceId}:all`;
  }

  /**
   * Generate cache key for conversation queries.
   *
   * @param id - Conversation ID (omit for list queries)
   * @param queryType - Type of query (default: 'get')
   * @returns Formatted cache key
   */
  static conversationKey(id?: string, queryType = 'get'): string {
    return id ? `conversation:${queryType}:${id}` : `conversation:${queryType}:all`;
  }

  /**
   * Generate cache key for message queries.
   *
   * @param conversationId - Parent conversation ID
   * @param queryType - Type of query (default: 'get')
   * @returns Formatted cache key
   */
  static messageKey(conversationId: string, queryType = 'get'): string {
    return `message:${queryType}:${conversationId}`;
  }

  /**
   * Generate cache key for project queries.
   *
   * @param workspaceId - Parent workspace ID
   * @param projectId - Project ID (omit for list queries)
   * @param queryType - Type of query (default: 'get')
   * @returns Formatted cache key
   */
  static projectKey(workspaceId: string, projectId?: string, queryType = 'get'): string {
    return projectId
      ? `project:${queryType}:${workspaceId}:${projectId}`
      : `project:${queryType}:${workspaceId}:all`;
  }

  /**
   * Generate cache key for task queries.
   *
   * @param projectId - Parent project ID
   * @param taskId - Task ID (omit for list queries)
   * @param queryType - Type of query (default: 'get')
   * @returns Formatted cache key
   */
  static taskKey(projectId: string, taskId?: string, queryType = 'get'): string {
    return taskId
      ? `task:${queryType}:${projectId}:${taskId}`
      : `task:${queryType}:${projectId}:all`;
  }

  /**
   * Generate cache key for search queries.
   *
   * @param searchType - Type of search (e.g., 'content', 'metadata')
   * @param searchQuery - Search query string (hashed for consistent keys)
   * @returns Formatted cache key
   */
  static searchKey(searchType: string, searchQuery: string): string {
    // Simple hash for query string (not cryptographic, just for cache key)
    const hash = searchQuery.split('').reduce((acc, char) => {
      return ((acc << 5) - acc) + char.charCodeAt(0);
    }, 0);
    return `search:${searchType}:${Math.abs(hash)}`;
  }
}
