/**
 * Location: src/database/services/cache/strategies/CacheStrategy.ts
 *
 * Purpose: Strategy interface for different cache types
 * Implements Strategy pattern for cache operations
 *
 * Used by: ContentCache for managing different cache types
 * Dependencies: None
 */

export interface CachedEntry {
  data: unknown;
  timestamp: number;
  size: number;
  ttl: number;
  accessCount: number;
  lastAccess: number;
}

export interface CacheStatistics {
  count: number;
  sizeMB: number;
  oldestEntry: number;
  newestEntry: number;
}

/**
 * Strategy interface for cache operations
 */
export interface CacheStrategy<T extends CachedEntry> {
  /**
   * Add entry to cache
   */
  set(key: string, entry: T): void;

  /**
   * Get entry from cache
   */
  get(key: string): T | null;

  /**
   * Check if entry exists
   */
  has(key: string): boolean;

  /**
   * Remove entry from cache
   */
  delete(key: string): boolean;

  /**
   * Clear all entries
   */
  clear(): void;

  /**
   * Get all entries
   */
  getAll(): Map<string, T>;

  /**
   * Get cache statistics
   */
  getStatistics(): CacheStatistics;

  /**
   * Clean up expired entries
   */
  cleanup(now: number): number;
}
