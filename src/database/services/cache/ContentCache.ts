/**
 * Location: src/database/services/cache/ContentCache.ts
 *
 * Summary: Consolidated content caching service using Strategy pattern
 * Refactored to use cache strategies following SOLID principles
 *
 * Used by: All services requiring content caching capabilities
 * Dependencies: BaseCacheStrategy, CacheEvictionPolicy
 */

import { App, Events, Plugin, TFile } from 'obsidian';
import { BaseCacheStrategy } from './strategies/BaseCacheStrategy';
import { CachedEntry } from './strategies/CacheStrategy';
import { CacheEvictionPolicy } from './CacheEvictionPolicy';

type FileCacheMetadata = ReturnType<App['metadataCache']['getFileCache']>;

interface MetadataCacheEntry extends CachedEntry {
  data: FileCacheMetadata;
}

interface ComputedCacheEntry extends CachedEntry {
  data: unknown;
}

export interface ContentCacheOptions {
  enableFileContentCache?: boolean;
  enableMetadataCache?: boolean;
  enableEmbeddingDataCache?: boolean;
  enableSearchCache?: boolean;
  defaultTTL?: number;
  maxCacheSize?: number;
  maxMemoryMB?: number;
}

export interface FileContent extends CachedEntry {
  filePath: string;
  content: string;
  metadata?: FileCacheMetadata;
  hash?: string;
}

export interface EmbeddingContent extends CachedEntry {
  filePath: string;
  embedding: number[];
  model: string;
  chunkIndex?: number;
}

export interface SearchResult extends CachedEntry {
  query: string;
  results: unknown[];
  type: string;
}

export interface CacheStats {
  totalEntries: number;
  totalSizeMB: number;
  hitRate: number;
  memoryUsageMB: number;
  cachesByType: Record<string, {
    count: number;
    sizeMB: number;
    oldestEntry: number;
    newestEntry: number;
  }>;
}

/**
 * File content cache strategy
 */
class FileContentCacheStrategy extends BaseCacheStrategy<FileContent> {}

/**
 * Embedding cache strategy
 */
class EmbeddingCacheStrategy extends BaseCacheStrategy<EmbeddingContent> {}

/**
 * Search results cache strategy
 */
class SearchCacheStrategy extends BaseCacheStrategy<SearchResult> {}

/**
 * Generic cached content strategy
 */
class GenericCacheStrategy<T extends CachedEntry> extends BaseCacheStrategy<T> {}

/**
 * Content Cache Service
 *
 * Provides unified caching with Strategy pattern for different cache types
 */
export class ContentCache extends Events {
  // Cache strategies
  private fileContentStrategy: FileContentCacheStrategy;
  private metadataStrategy: GenericCacheStrategy<MetadataCacheEntry>;
  private embeddingStrategy: EmbeddingCacheStrategy;
  private searchResultsStrategy: SearchCacheStrategy;
  private computedStrategy: GenericCacheStrategy<ComputedCacheEntry>;

  // Cache statistics
  private hits = 0;
  private misses = 0;
  private currentMemoryMB = 0;

  // Configuration
  private readonly defaultTTL: number;
  private readonly maxCacheSize: number;
  private readonly maxMemoryMB: number;

  // Cleanup timer
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private plugin: Plugin,
    private options: ContentCacheOptions = {}
  ) {
    super();

    // Apply default configuration
    this.defaultTTL = options.defaultTTL || 30 * 60 * 1000; // 30 minutes
    this.maxCacheSize = options.maxCacheSize || 1000;
    this.maxMemoryMB = options.maxMemoryMB || 100; // 100MB default

    // Initialize cache strategies
    this.fileContentStrategy = new FileContentCacheStrategy();
    this.metadataStrategy = new GenericCacheStrategy<MetadataCacheEntry>();
    this.embeddingStrategy = new EmbeddingCacheStrategy();
    this.searchResultsStrategy = new SearchCacheStrategy();
    this.computedStrategy = new GenericCacheStrategy<ComputedCacheEntry>();

    // Start periodic cleanup
    this.startCleanupTimer();
  }

  // =============================================================================
  // FILE CONTENT CACHING
  // =============================================================================

  /**
   * Cache file content with metadata
   */
  async cacheFileContent(
    filePath: string,
    content: string,
    metadata?: FileCacheMetadata,
    ttl?: number
  ): Promise<void> {
    if (!this.options.enableFileContentCache) {
      return;
    }

    const size = this.estimateSize(content);
    const cacheEntry: FileContent = {
      filePath,
      content,
      metadata,
      hash: this.generateHash(content),
      data: { content, metadata },
      timestamp: Date.now(),
      size,
      ttl: ttl || this.defaultTTL,
      accessCount: 1,
      lastAccess: Date.now()
    };

    this.fileContentStrategy.set(filePath, cacheEntry);
    this.currentMemoryMB += size / (1024 * 1024);

    this.trigger('cached', { type: 'file', filePath, size });
    this.enforceMemoryLimits();
  }

  /**
   * Get cached file content
   */
  getCachedFileContent(filePath: string): FileContent | null {
    const cached = this.fileContentStrategy.get(filePath);

    if (!cached) {
      this.misses++;
      return null;
    }

    this.hits++;
    return cached;
  }

  /**
   * Cache file content from TFile
   */
  async cacheFile(file: TFile, ttl?: number): Promise<void> {
    try {
      const content = await this.plugin.app.vault.read(file);
      const metadata = this.plugin.app.metadataCache.getFileCache(file);

      await this.cacheFileContent(file.path, content, metadata, ttl);
    } catch (error) {
      console.error(`[ContentCache] Failed to cache file ${file.path}:`, error);
    }
  }

  // =============================================================================
  // EMBEDDING CACHING
  // =============================================================================

  /**
   * Cache embedding data
   */
  cacheEmbedding(
    filePath: string,
    embedding: number[],
    model: string,
    chunkIndex?: number,
    ttl?: number
  ): void {
    if (!this.options.enableEmbeddingDataCache) {
      return;
    }

    const cacheKey = this.getEmbeddingCacheKey(filePath, model, chunkIndex);
    const size = this.estimateSize(embedding);

    const cacheEntry: EmbeddingContent = {
      filePath,
      embedding,
      model,
      chunkIndex,
      data: embedding,
      timestamp: Date.now(),
      size,
      ttl: ttl || this.defaultTTL,
      accessCount: 1,
      lastAccess: Date.now()
    };

    this.embeddingStrategy.set(cacheKey, cacheEntry);
    this.currentMemoryMB += size / (1024 * 1024);

    this.trigger('cached', { type: 'embedding', filePath, model, size });
    this.enforceMemoryLimits();
  }

  /**
   * Get cached embedding
   */
  getCachedEmbedding(
    filePath: string,
    model: string,
    chunkIndex?: number
  ): EmbeddingContent | null {
    const cacheKey = this.getEmbeddingCacheKey(filePath, model, chunkIndex);
    const cached = this.embeddingStrategy.get(cacheKey);

    if (!cached) {
      this.misses++;
      return null;
    }

    this.hits++;
    return cached;
  }

  // =============================================================================
  // SEARCH RESULT CACHING
  // =============================================================================

  /**
   * Cache search results
   */
  cacheSearchResults(
    query: string,
    results: unknown[],
    searchType: string,
    ttl?: number
  ): void {
    if (!this.options.enableSearchCache) {
      return;
    }

    const cacheKey = this.getSearchCacheKey(query, searchType);
    const size = this.estimateSize(results);

    const cacheEntry: SearchResult = {
      query,
      results,
      type: searchType,
      data: results,
      timestamp: Date.now(),
      size,
      ttl: ttl || this.defaultTTL / 2, // Search results expire faster
      accessCount: 1,
      lastAccess: Date.now()
    };

    this.searchResultsStrategy.set(cacheKey, cacheEntry);
    this.currentMemoryMB += size / (1024 * 1024);

    this.trigger('cached', { type: 'search', query, searchType, size });
    this.enforceMemoryLimits();
  }

  /**
   * Get cached search results
   */
  getCachedSearchResults(query: string, searchType: string): SearchResult | null {
    const cacheKey = this.getSearchCacheKey(query, searchType);
    const cached = this.searchResultsStrategy.get(cacheKey);

    if (!cached) {
      this.misses++;
      return null;
    }

    this.hits++;
    return cached;
  }

  // =============================================================================
  // GENERIC COMPUTED VALUE CACHING
  // =============================================================================

  /**
   * Cache computed value with custom key
   */
  cacheValue<T>(key: string, value: T, ttl?: number): void {
    const size = this.estimateSize(value);

    const cacheEntry: ComputedCacheEntry = {
      data: value,
      timestamp: Date.now(),
      size,
      ttl: ttl || this.defaultTTL,
      accessCount: 1,
      lastAccess: Date.now()
    };

    this.computedStrategy.set(key, cacheEntry);
    this.currentMemoryMB += size / (1024 * 1024);

    this.trigger('cached', { type: 'computed', key, size });
    this.enforceMemoryLimits();
  }

  /**
   * Get cached computed value
   */
  getCachedValue<T>(key: string): T | null {
    const cached = this.computedStrategy.get(key);

    if (!cached) {
      this.misses++;
      return null;
    }

    this.hits++;
    return cached.data as T;
  }

  // =============================================================================
  // CACHE INVALIDATION AND MANAGEMENT
  // =============================================================================

  /**
   * Invalidate all caches for a specific file
   */
  invalidateFile(filePath: string): void {
    // Remove file content cache
    this.fileContentStrategy.delete(filePath);

    // Remove embedding caches for this file
    const embeddingCache = this.embeddingStrategy.getAll();
    for (const key of embeddingCache.keys()) {
      if (key.startsWith(`${filePath}:`)) {
        this.embeddingStrategy.delete(key);
      }
    }

    // Remove metadata cache
    this.metadataStrategy.delete(filePath);

    this.trigger('invalidated', { type: 'file', filePath });
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.fileContentStrategy.clear();
    this.metadataStrategy.clear();
    this.embeddingStrategy.clear();
    this.searchResultsStrategy.clear();
    this.computedStrategy.clear();

    this.currentMemoryMB = 0;
    this.hits = 0;
    this.misses = 0;

    this.trigger('cleared');
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    cleanedCount += this.fileContentStrategy.cleanup(now);
    cleanedCount += this.embeddingStrategy.cleanup(now);
    cleanedCount += this.searchResultsStrategy.cleanup(now);
    cleanedCount += this.computedStrategy.cleanup(now);

    if (cleanedCount > 0) {
      this.trigger('cleaned', { removedEntries: cleanedCount });
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      totalEntries: this.getTotalEntries(),
      totalSizeMB: this.currentMemoryMB,
      hitRate,
      memoryUsageMB: this.currentMemoryMB,
      cachesByType: {
        fileContent: this.fileContentStrategy.getStatistics(),
        embeddingData: this.embeddingStrategy.getStatistics(),
        searchResults: this.searchResultsStrategy.getStatistics(),
        computed: this.computedStrategy.getStatistics()
      }
    };
  }

  /**
   * Shutdown the cache service
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.clearAll();
  }

  // =============================================================================
  // PRIVATE HELPER METHODS
  // =============================================================================

  private startCleanupTimer(): void {
    // Clean up every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
  }

  private enforceMemoryLimits(): void {
    if (this.currentMemoryMB <= this.maxMemoryMB) {
      return;
    }

    // Collect all cache groups
    const cacheGroups = new Map<string, Map<string, CachedEntry>>([
      ['file', this.fileContentStrategy.getAll()],
      ['embedding', this.embeddingStrategy.getAll()],
      ['searchResults', this.searchResultsStrategy.getAll()],
      ['computed', this.computedStrategy.getAll()]
    ]);

    // Use eviction policy to remove LRU entries
    const { evictedCount, freedMemoryMB } = CacheEvictionPolicy.enforceLimits(
      cacheGroups,
      this.currentMemoryMB,
      this.maxMemoryMB,
      (key, type, sizeMB) => {
        this.trigger('evicted', { key, type, sizeMB });
      }
    );

    this.currentMemoryMB -= freedMemoryMB;

    if (evictedCount > 0) {
      this.trigger('memoryLimitEnforced', { removedEntries: evictedCount, freedMemoryMB });
    }
  }

  private getTotalEntries(): number {
    return this.fileContentStrategy.getStatistics().count +
           this.embeddingStrategy.getStatistics().count +
           this.searchResultsStrategy.getStatistics().count +
           this.computedStrategy.getStatistics().count +
           this.metadataStrategy.getStatistics().count;
  }

  private estimateSize(data: unknown): number {
    // Rough estimation of object size in bytes
    try {
      const jsonString = JSON.stringify(data);
      return jsonString.length * 2; // Assume 2 bytes per character for Unicode
    } catch {
      return 1024; // Default 1KB if cannot stringify
    }
  }

  private generateHash(content: string): string {
    // Simple hash function for content comparison
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  private getEmbeddingCacheKey(
    filePath: string,
    model: string,
    chunkIndex?: number
  ): string {
    return `${filePath}:${model}${chunkIndex !== undefined ? `:${chunkIndex}` : ''}`;
  }

  private getSearchCacheKey(query: string, searchType: string): string {
    return `${searchType}:${this.generateHash(query)}`;
  }
}
