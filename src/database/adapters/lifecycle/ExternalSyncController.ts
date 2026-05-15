/**
 * Owns the JSONL vault watcher lifecycle and the `external-sync` event
 * bus that the adapter exposes to UI consumers.
 *
 * Triggered by JsonlVaultWatcher when something modifies a JSONL stream
 * outside our own writes (typically Obsidian Sync landing a file from
 * another device). On change, we either scope-reconcile via the
 * ReconcilePipeline (preferred, sync-safe) or fall back to a full
 * `syncCoordinator.sync()`, then emit `external-sync` so views can refresh.
 */

import { App, Events, EventRef } from 'obsidian';
import { JSONLWriter } from '../../storage/JSONLWriter';
import { SyncCoordinator } from '../../sync/SyncCoordinator';
import { JsonlVaultWatcher, ModifiedStream } from '../../sync/JsonlVaultWatcher';
import { QueryCache } from '../../optimizations/QueryCache';
import { SyncResult } from '../../../types/storage/HybridStorageTypes';
import { MissingEntityReconcilerRunner } from './MissingEntityReconcilers';

export interface ExternalSyncEvent {
  result: SyncResult;
  modified: ModifiedStream[];
}

export interface ExternalSyncControllerDeps {
  app: App;
  getDataPath: () => string;
  jsonlWriter: JSONLWriter;
  syncCoordinator: SyncCoordinator;
  queryCache: QueryCache;
  reconcilers: MissingEntityReconcilerRunner;
  /** True once the reconcile pipeline is wired (scoped reconcile available). */
  isReconcilePipelineWired: () => boolean;
  /** Fallback full-sync used when the pipeline isn't wired. */
  fallbackFullSync: () => Promise<SyncResult>;
}

export class ExternalSyncController {
  private readonly events = new Events();
  private watcher?: JsonlVaultWatcher;

  constructor(private readonly deps: ExternalSyncControllerDeps) {}

  /**
   * Subscribe to external-sync. Returns an Obsidian EventRef compatible
   * with `plugin.registerEvent(ref)`.
   */
  on(callback: (event: ExternalSyncEvent) => void): EventRef {
    return this.events.on('external-sync', (...data: unknown[]) => {
      callback(data[0] as ExternalSyncEvent);
    });
  }

  off(ref: EventRef): void {
    this.events.offref(ref);
  }

  /** Idempotent. Wires the JSONLWriter before-write hook to suppress self-echoes. */
  start(): void {
    if (this.watcher) return;

    const watcher = new JsonlVaultWatcher({
      app: this.deps.app,
      dataPath: this.deps.getDataPath(),
      onChange: (modified) => this.handleChange(modified)
    });

    this.watcher = watcher;
    this.deps.jsonlWriter.setBeforeWriteHook((logicalPath) => {
      watcher.suppressLogicalPath(logicalPath);
    });

    watcher.start();
  }

  /** Idempotent. Safe to call if never started. */
  stop(): void {
    if (!this.watcher) return;
    this.deps.jsonlWriter.setBeforeWriteHook(undefined);
    this.watcher.stop();
    this.watcher = undefined;
  }

  /** Used by `relocateVaultRoot` after a verified swap. */
  setDataPath(newDataPath: string): void {
    this.watcher?.setDataPath(newDataPath);
  }

  private async handleChange(modified: ModifiedStream[]): Promise<void> {
    if (modified.length === 0) return;
    try {
      let result: SyncResult;
      if (this.deps.isReconcilePipelineWired()) {
        for (const m of modified) {
          await this.deps.syncCoordinator.reconcileStream(m.category, m.streamId);
        }
        await this.deps.reconcilers.runAll();
        this.deps.queryCache.clear();
        result = {
          success: true,
          eventsApplied: 0,
          eventsSkipped: 0,
          errors: [],
          duration: 0,
          filesProcessed: modified.map((m) => m.samplePath),
          lastSyncTimestamp: Date.now()
        };
      } else {
        result = await this.deps.fallbackFullSync();
      }
      this.events.trigger('external-sync', { result, modified } satisfies ExternalSyncEvent);
    } catch (error) {
      console.error('[HybridStorageAdapter] External JSONL change sync failed:', error);
    }
  }
}
