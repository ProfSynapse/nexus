/**
 * Location: /src/database/sync/index.ts
 *
 * Synchronization utilities for hybrid storage system.
 *
 * Coordinates sync between JSONL (source of truth) and SQLite (cache).
 *
 * Related Files:
 * - /src/database/storage/JSONLWriter.ts - JSONL event log
 * - /src/database/storage/SQLiteCacheManager.ts - SQLite cache
 * - /src/database/optimizations/BatchOperations.ts - Used for batch processing
 */

export { SyncCoordinator } from './SyncCoordinator';
export { TaskEventApplier } from './TaskEventApplier';
export { resolveWorkspaceId } from './resolveWorkspaceId';
export type { ResolveResult } from './resolveWorkspaceId';
export type {
  SyncResult,
  SyncOptions,
  SyncState,
  IJSONLWriter,
  ISQLiteCacheManager
} from './SyncCoordinator';
