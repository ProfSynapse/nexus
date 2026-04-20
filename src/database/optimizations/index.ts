/**
 * Location: /src/database/optimizations/index.ts
 *
 * Database optimization utilities for hybrid storage system.
 *
 * This module provides performance optimization utilities for the hybrid
 * JSONL + SQLite storage architecture:
 *
 * - BatchOperations: Process large datasets in chunks with progress tracking
 * - QueryCache: Cache expensive queries with TTL and pattern-based invalidation
 *
 * Related Files:
 * - /src/database/sync/SyncCoordinator.ts - Sync coordination (separate export)
 * - /src/database/storage/JSONLWriter.ts - JSONL event log
 * - /src/database/storage/SQLiteCacheManager.ts - SQLite cache
 */

// Export batch operations
export { BatchOperations } from './BatchOperations';
export type { BatchOptions, BatchResult } from './BatchOperations';

// Export query cache
export { QueryCache } from './QueryCache';
export type { CacheEntry, CacheStats } from './QueryCache';
