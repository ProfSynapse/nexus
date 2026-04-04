/**
 * Location: src/database/services/cache/CacheEvictionPolicy.ts
 *
 * Purpose: Cache eviction policy for memory management
 * Extracted from ContentCache.ts to follow Single Responsibility Principle
 *
 * Used by: ContentCache for enforcing memory limits
 * Dependencies: CacheStrategy
 */

import { CachedEntry } from './strategies/CacheStrategy';

export interface EvictionEntry {
  key: string;
  entry: CachedEntry;
  type: string;
}

/**
 * Manages cache eviction when memory limits are exceeded
 */
export class CacheEvictionPolicy {
  /**
   * Enforce memory limits by evicting least recently used entries
   *
   * @param cacheGroups - Map of cache types to their strategies
   * @param currentMemoryMB - Current memory usage in MB
   * @param maxMemoryMB - Maximum allowed memory in MB
   * @param onEvict - Callback when entry is evicted
   * @returns Number of entries evicted
   */
  static enforceLimits(
    cacheGroups: Map<string, Map<string, CachedEntry>>,
    currentMemoryMB: number,
    maxMemoryMB: number,
    onEvict?: (key: string, type: string, sizeMB: number) => void
  ): { evictedCount: number; freedMemoryMB: number } {
    if (currentMemoryMB <= maxMemoryMB) {
      return { evictedCount: 0, freedMemoryMB: 0 };
    }

    // Collect all entries with their keys and types
    const allEntries: EvictionEntry[] = [];

    for (const [type, cacheMap] of cacheGroups.entries()) {
      for (const [key, entry] of cacheMap.entries()) {
        allEntries.push({ key, entry, type });
      }
    }

    // Sort by last access time (oldest first) - LRU policy
    allEntries.sort((a, b) => a.entry.lastAccess - b.entry.lastAccess);

    // Remove entries until under memory limit
    let evictedCount = 0;
    let freedMemoryMB = 0;
    const targetMemoryMB = maxMemoryMB * 0.8; // Target 80% of limit

    for (const { key, entry, type } of allEntries) {
      if ((currentMemoryMB - freedMemoryMB) <= targetMemoryMB) {
        break; // Stop when under 80% of limit
      }

      const cacheMap = cacheGroups.get(type);
      if (cacheMap) {
        cacheMap.delete(key);
        const entrySizeMB = entry.size / (1024 * 1024);
        freedMemoryMB += entrySizeMB;
        evictedCount++;

        if (onEvict) {
          onEvict(key, type, entrySizeMB);
        }
      }
    }

    return { evictedCount, freedMemoryMB };
  }

  /**
   * Get eviction candidates (entries that would be evicted next)
   */
  static getEvictionCandidates(
    cacheGroups: Map<string, Map<string, CachedEntry>>,
    count = 10
  ): EvictionEntry[] {
    const allEntries: EvictionEntry[] = [];

    for (const [type, cacheMap] of cacheGroups.entries()) {
      for (const [key, entry] of cacheMap.entries()) {
        allEntries.push({ key, entry, type });
      }
    }

    // Sort by last access time (oldest first)
    allEntries.sort((a, b) => a.entry.lastAccess - b.entry.lastAccess);

    return allEntries.slice(0, count);
  }

  /**
   * Calculate priority score for cache entry
   * Higher score = higher priority (less likely to be evicted)
   */
  static calculatePriority(entry: CachedEntry): number {
    const recencyScore = (Date.now() - entry.lastAccess) / (1000 * 60 * 60); // Hours since last access
    const frequencyScore = entry.accessCount;
    const ageScore = (Date.now() - entry.timestamp) / (1000 * 60 * 60 * 24); // Days since creation

    // Weighted priority: recent access and frequency are more important than age
    return (frequencyScore * 0.5) + (1 / (recencyScore + 1) * 0.4) + (1 / (ageScore + 1) * 0.1);
  }
}
