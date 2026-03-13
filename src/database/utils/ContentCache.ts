/**
 * Cache entry for file content
 */
interface CacheEntry {
  content: string;
  timestamp: number;
  size: number;
}

/**
 * LRU (Least Recently Used) cache for file contents
 * Used to temporarily store file contents before modifications
 */
export class ContentCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize: number;
  private currentSize = 0;
  private ttl: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new content cache
   * @param maxSize Maximum cache size in bytes (default: 10MB)
   * @param ttl Time to live in milliseconds (default: 5 minutes)
   */
  constructor(maxSize: number = 10 * 1024 * 1024, ttl: number = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttl = ttl;

    // Periodically clean up expired entries
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60 * 1000); // Every minute
  }
  
  /**
   * Get content from cache
   * @param filePath File path
   * @returns Content if found and not expired, undefined otherwise
   */
  get(filePath: string): string | undefined {
    const entry = this.cache.get(filePath);
    if (!entry) return undefined;
    
    // Check if expired
    if (Date.now() - entry.timestamp > this.ttl) {
      this.delete(filePath);
      return undefined;
    }
    
    // Move to end (most recently used)
    this.cache.delete(filePath);
    this.cache.set(filePath, entry);
    
    return entry.content;
  }
  
  /**
   * Store content in cache
   * @param filePath File path
   * @param content File content
   */
  set(filePath: string, content: string): void {
    // Remove existing entry if present
    if (this.cache.has(filePath)) {
      this.delete(filePath);
    }
    
    const size = content.length * 2; // Approximate size in bytes (UTF-16)
    
    // Make room if needed
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.delete(firstKey);
      }
    }
    
    // Add new entry
    this.cache.set(filePath, {
      content,
      timestamp: Date.now(),
      size
    });
    
    this.currentSize += size;
  }
  
  /**
   * Delete an entry from cache
   * @param filePath File path
   */
  delete(filePath: string): boolean {
    const entry = this.cache.get(filePath);
    if (!entry) return false;
    
    this.cache.delete(filePath);
    this.currentSize -= entry.size;
    return true;
  }
  
  /**
   * Clear all entries from cache
   */
  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }

  /**
   * Destroy the cache and stop the cleanup timer
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
  }
  
  /**
   * Clean up expired entries
   */
  private cleanupExpired(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        expiredKeys.push(key);
      }
    }
    
    for (const key of expiredKeys) {
      this.delete(key);
    }
  }
  
  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    entries: number;
    utilization: number;
  } {
    return {
      size: this.currentSize,
      maxSize: this.maxSize,
      entries: this.cache.size,
      utilization: this.currentSize / this.maxSize
    };
  }
}