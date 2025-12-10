/**
 * Cache Manager
 * Provides in-memory LRU cache and file-based cache implementations
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * - Uses Web Crypto API instead of Node.js crypto
 * - Uses Obsidian's Vault API instead of Node.js fs
 * - Falls back to memory-only caching if vault adapter not configured
 */

import { normalizePath } from 'obsidian';
import { logger } from './Logger';

// Browser-compatible hash function using Web Crypto API
async function generateHashAsync(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Synchronous fallback using simple hash (for cases where async isn't possible)
function generateHashSync(input: string): string {
  // Simple djb2 hash - not cryptographically secure but sufficient for cache keys
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

export interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl?: number;
  hits: number;
}

export interface CacheConfig {
  maxSize: number;
  defaultTTL: number; // in milliseconds
  persistToDisk: boolean;
  cacheDir: string;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

export interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  list?(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export abstract class BaseCache<T> {
  protected config: CacheConfig;
  protected metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    size: 0
  };

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      maxSize: config.maxSize || 1000,
      defaultTTL: config.defaultTTL || 3600000, // 1 hour default
      persistToDisk: config.persistToDisk || false,
      cacheDir: config.cacheDir || '.cache'
    };
  }

  abstract get(key: string): Promise<T | null>;
  abstract set(key: string, value: T, ttl?: number): Promise<void>;
  abstract delete(key: string): Promise<boolean>;
  abstract clear(): Promise<void>;
  abstract size(): number;

  getMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  protected isExpired(entry: CacheEntry<T>): boolean {
    if (!entry.ttl) return false;
    return Date.now() - entry.timestamp > entry.ttl;
  }

  protected generateHash(input: string): string {
    // Use synchronous hash for cache keys (async not needed for this use case)
    return generateHashSync(input);
  }

  protected async generateHashSecure(input: string): Promise<string> {
    return generateHashAsync(input);
  }
}

export class LRUCache<T> extends BaseCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private accessOrder = new Map<string, number>();
  private accessCounter = 0;

  async get(key: string): Promise<T | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      this.metrics.misses++;
      return null;
    }

    if (this.isExpired(entry)) {
      await this.delete(key);
      this.metrics.misses++;
      return null;
    }

    // Update access order for LRU
    this.accessOrder.set(key, ++this.accessCounter);
    entry.hits++;
    this.metrics.hits++;

    return entry.value;
  }

  async set(key: string, value: T, ttl?: number): Promise<void> {
    // Check if we need to evict
    if (this.cache.size >= this.config.maxSize && !this.cache.has(key)) {
      await this.evictLRU();
    }

    const entry: CacheEntry<T> = {
      value,
      timestamp: Date.now(),
      ttl: ttl || this.config.defaultTTL,
      hits: 0
    };

    this.cache.set(key, entry);
    this.accessOrder.set(key, ++this.accessCounter);
    this.metrics.size = this.cache.size;

    // Persist to disk if configured and vault adapter available
    if (this.config.persistToDisk && CacheManager.vaultAdapterConfig) {
      await this.persistEntry(key, entry);
    }
  }

  async delete(key: string): Promise<boolean> {
    const deleted = this.cache.delete(key);
    this.accessOrder.delete(key);

    if (deleted) {
      this.metrics.size = this.cache.size;
    }

    return deleted;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.accessOrder.clear();
    this.accessCounter = 0;
    this.metrics.size = 0;
  }

  size(): number {
    return this.cache.size;
  }

  private async evictLRU(): Promise<void> {
    let lruKey: string | null = null;
    let lruOrder = Infinity;

    for (const [key, order] of this.accessOrder.entries()) {
      if (order < lruOrder) {
        lruOrder = order;
        lruKey = key;
      }
    }

    if (lruKey) {
      await this.delete(lruKey);
      this.metrics.evictions++;
    }
  }

  private async persistEntry(key: string, entry: CacheEntry<T>): Promise<void> {
    if (!CacheManager.vaultAdapterConfig) {
      // No vault adapter configured - skip disk persistence
      return;
    }

    const hashed = `${this.generateHash(key)}.json`;
    const adapter = CacheManager.vaultAdapterConfig.adapter;
    const dir = normalizePath(CacheManager.vaultAdapterConfig.baseDir);
    const filePath = normalizePath(`${dir}/${hashed}`);

    try {
      await adapter.mkdir(dir);
      await adapter.write(filePath, JSON.stringify({ key, entry }));
    } catch (error) {
      logger.warn('Failed to persist cache entry via vault adapter:', { error: (error as Error).message });
    }
  }
}

export class FileCache<T> extends BaseCache<T> {
  private memoryCache = new Map<string, CacheEntry<T>>();
  private baseDir: string;

  constructor(config: Partial<CacheConfig> = {}) {
    super({ ...config, persistToDisk: true });
    this.baseDir = CacheManager.vaultAdapterConfig?.baseDir || config.cacheDir || '.cache';
    this.initializeCache();
  }

  async get(key: string): Promise<T | null> {
    // Check memory first
    let entry = this.memoryCache.get(key);

    // If not in memory, try disk
    if (!entry) {
      entry = (await this.loadFromDisk(key)) || undefined;
      if (entry) {
        this.memoryCache.set(key, entry);
      }
    }

    if (!entry) {
      this.metrics.misses++;
      return null;
    }

    if (this.isExpired(entry)) {
      await this.delete(key);
      this.metrics.misses++;
      return null;
    }

    entry.hits++;
    this.metrics.hits++;
    return entry.value;
  }

  async set(key: string, value: T, ttl?: number): Promise<void> {
    const entry: CacheEntry<T> = {
      value,
      timestamp: Date.now(),
      ttl: ttl || this.config.defaultTTL,
      hits: 0
    };

    this.memoryCache.set(key, entry);
    await this.saveToDisk(key, entry);
    this.metrics.size++;
  }

  async delete(key: string): Promise<boolean> {
    const memoryDeleted = this.memoryCache.delete(key);
    const diskDeleted = await this.deleteFromDisk(key);

    if (memoryDeleted || diskDeleted) {
      this.metrics.size--;
      return true;
    }
    return false;
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    await this.clearVaultCache();
    this.metrics.size = 0;
  }

  size(): number {
    return this.memoryCache.size;
  }

  private async initializeCache(): Promise<void> {
    if (!CacheManager.vaultAdapterConfig) {
      // No vault adapter - memory-only mode
      return;
    }

    try {
      const dir = this.getCacheDir();
      await CacheManager.vaultAdapterConfig.adapter.mkdir(dir);
    } catch (error) {
      logger.warn('Failed to initialize cache directory via vault adapter:', { error: (error as Error).message });
    }
  }

  private async loadFromDisk(key: string): Promise<CacheEntry<T> | null> {
    if (!CacheManager.vaultAdapterConfig) {
      return null;
    }

    const hashed = `${this.generateHash(key)}.json`;
    const adapter = CacheManager.vaultAdapterConfig.adapter;
    const filePath = this.normalizeVaultPath(`${this.baseDir}/${hashed}`);

    try {
      const exists = await adapter.exists(filePath);
      if (!exists) return null;
      const data = await adapter.read(filePath);
      const parsed = JSON.parse(data);
      return parsed.entry;
    } catch {
      return null;
    }
  }

  private async saveToDisk(key: string, entry: CacheEntry<T>): Promise<void> {
    if (!CacheManager.vaultAdapterConfig) {
      return;
    }

    const hashed = `${this.generateHash(key)}.json`;
    const adapter = CacheManager.vaultAdapterConfig.adapter;
    const filePath = this.normalizeVaultPath(`${this.baseDir}/${hashed}`);

    try {
      await adapter.write(filePath, JSON.stringify({ key, entry }));
    } catch (error) {
      logger.warn('Failed to save cache entry to vault:', { error: (error as Error).message });
    }
  }

  private async deleteFromDisk(key: string): Promise<boolean> {
    if (!CacheManager.vaultAdapterConfig) {
      return false;
    }

    const hashed = `${this.generateHash(key)}.json`;
    const adapter = CacheManager.vaultAdapterConfig.adapter;
    const filePath = this.normalizeVaultPath(`${this.baseDir}/${hashed}`);

    try {
      await adapter.remove(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async clearVaultCache(): Promise<void> {
    if (!CacheManager.vaultAdapterConfig) {
      return;
    }

    const adapter = CacheManager.vaultAdapterConfig.adapter;
    const dir = this.getCacheDir();

    try {
      if (adapter.list) {
        const contents = await adapter.list(dir);
        for (const file of contents.files) {
          if (file.endsWith('.json')) {
            await adapter.remove(this.normalizeVaultPath(`${dir}/${file}`));
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to clear vault cache:', { error: (error as Error).message });
    }
  }

  private getCacheDir(): string {
    return this.normalizeVaultPath(this.baseDir);
  }

  private normalizeVaultPath(p: string): string {
    return normalizePath(p);
  }
}

/**
 * CacheManager singleton
 * Manages multiple cache instances and provides centralized configuration
 */
export class CacheManager {
  private static instances = new Map<string, BaseCache<any>>();
  static vaultAdapterConfig: { adapter: VaultAdapter; baseDir: string } | null = null;

  static getLRUCache<T>(name: string, config?: Partial<CacheConfig>): LRUCache<T> {
    if (!this.instances.has(name)) {
      this.instances.set(name, new LRUCache<T>(config));
    }
    return this.instances.get(name) as LRUCache<T>;
  }

  static getFileCache<T>(name: string, config?: Partial<CacheConfig>): FileCache<T> {
    if (!this.instances.has(name)) {
      this.instances.set(name, new FileCache<T>(config));
    }
    return this.instances.get(name) as FileCache<T>;
  }

  static async clearAll(): Promise<void> {
    for (const cache of this.instances.values()) {
      await cache.clear();
    }
  }

  static getAllMetrics(): Record<string, CacheMetrics> {
    const metrics: Record<string, CacheMetrics> = {};
    for (const [name, cache] of this.instances.entries()) {
      metrics[name] = cache.getMetrics();
    }
    return metrics;
  }

  /**
   * Configure a vault adapter so cache persistence uses Obsidian API.
   * Must be called before creating file-based caches for disk persistence to work.
   */
  static configureVaultAdapter(adapter: VaultAdapter, baseDir: string = '.nexus/cache') {
    this.vaultAdapterConfig = { adapter, baseDir };
  }
}
