/**
 * Coalesced "wipe and rebuild" cache operation.
 *
 * Backs `HybridStorageAdapter.rebuildCache` (the "Nexus: Rebuild cache"
 * command). A second invocation while one is in flight returns the same
 * promise so a double-click can't start two simultaneous rebuilds (which
 * would race over close/remove/initialize/save on the underlying cache).
 */

import { SQLiteCacheManager } from '../../storage/SQLiteCacheManager';
import { SyncCoordinator } from '../../sync/SyncCoordinator';
import type { CacheBlobStore } from '../../storage/CacheBlobStore';
import type { InitLifecycleController } from './InitLifecycleController';

export interface CacheRebuildOperationDeps {
  getSqliteCache: () => SQLiteCacheManager;
  getSyncCoordinator: () => SyncCoordinator | undefined;
  getCacheBlobStore: () => CacheBlobStore;
  getInitLifecycle: () => InitLifecycleController;
}

export type RebuildProgress = (label: string, done: number, total: number) => void;

export class CacheRebuildOperation {
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: CacheRebuildOperationDeps) {}

  run(options: { onProgress?: RebuildProgress } = {}): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        if (!this.deps.getInitLifecycle().isInitialized()) {
          throw new Error('Storage adapter is not initialized; cannot rebuild cache');
        }

        const cache = this.deps.getSqliteCache();
        const blob = this.deps.getCacheBlobStore();
        const coord = this.deps.getSyncCoordinator();

        options.onProgress?.('Stopping auto-save', 0, 1);
        cache.stopAutoSave();

        options.onProgress?.('Closing cache', 0, 1);
        await cache.close();

        options.onProgress?.('Removing cache blob', 0, 1);
        await blob.remove();

        options.onProgress?.('Reopening cache', 0, 1);
        await cache.initialize();

        if (!coord) {
          throw new Error('Sync coordinator unavailable; cannot rebuild from JSONL');
        }

        options.onProgress?.('Rebuilding from JSONL', 0, 1);
        const result = await coord.fullRebuild({ onProgress: options.onProgress });

        if (!result.success) {
          const summary = result.errors.length > 0 ? result.errors.join('; ') : 'Unknown error';
          throw new Error(`Cache rebuild failed: ${summary}`);
        }

        await cache.save();
        options.onProgress?.('Complete', 1, 1);
      } finally {
        // Clear on both success and failure so a follow-up rebuild can
        // re-run; the original error (if any) still rejects this promise.
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }
}
