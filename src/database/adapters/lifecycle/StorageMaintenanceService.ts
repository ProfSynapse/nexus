import { App, Events, EventRef } from 'obsidian';
import { JSONLWriter } from '../../storage/JSONLWriter';
import { SQLiteCacheManager } from '../../storage/SQLiteCacheManager';
import { SyncCoordinator } from '../../sync/SyncCoordinator';
import { JsonlVaultWatcher, ModifiedStream } from '../../sync/JsonlVaultWatcher';
import { ReconcilePipeline } from '../../sync/ReconcilePipeline';
import { QueryCache } from '../../optimizations/QueryCache';
import { SyncResult } from '../../../types/storage/HybridStorageTypes';
import { WorkspaceEvent, ConversationEvent, TaskEvent } from '../../interfaces/StorageEvents';
import { WorkspaceEventApplier } from '../../sync/WorkspaceEventApplier';
import { ConversationEventApplier } from '../../sync/ConversationEventApplier';
import { TaskEventApplier } from '../../sync/TaskEventApplier';
import { resolveWorkspaceId } from '../../sync/resolveWorkspaceId';
import {
  VaultRootRelocationService,
  type VaultRootRelocationResult
} from '../../migration/VaultRootRelocationService';
import { resolveVaultRoot } from '../../storage/VaultRootResolver';
import { VaultEventStore } from '../../storage/vaultRoot/VaultEventStore';
import { DEFAULT_STORAGE_SETTINGS } from '../../../types/plugin/PluginTypes';
import type { CacheBlobStore } from '../../storage/CacheBlobStore';
import { InitLifecycleController } from './InitLifecycleController';
import {
  ReconciliationCoordinator,
  type ReconcileCategory
} from './ReconciliationCoordinator';
import type { WorkspaceRepository } from '../../repositories/WorkspaceRepository';
import type { ConversationRepository } from '../../repositories/ConversationRepository';
import type { ExternalSyncEvent } from '../HybridStorageAdapter';

/**
 * Dependencies the maintenance service reaches through the adapter.
 *
 * Everything is an accessor callback evaluated at call time rather than a
 * captured reference: the adapter reassigns `basePath`, `vaultEventStore`,
 * `reconcilePipeline`, `reconciliationCoordinator`, and the vault-watcher
 * handle at runtime (`applyStoragePlan`, `relocateVaultRoot`,
 * re-initialization), and that mutable state stays adapter-owned so the
 * adapter remains the single source of truth. The `reconcileMissing*`
 * callbacks dispatch back through the adapter instance so the post-sync
 * reconcilers always run the adapter's current implementation.
 */
export interface StorageMaintenanceDeps {
  getApp(): App;
  getJsonlWriter(): JSONLWriter;
  getSqliteCache(): SQLiteCacheManager;
  getSyncCoordinator(): SyncCoordinator;
  getQueryCache(): QueryCache;
  getCacheBlobStore(): CacheBlobStore;
  getInitLifecycle(): InitLifecycleController;
  getReconciliationCoordinator(): ReconciliationCoordinator;
  getWorkspaceRepo(): WorkspaceRepository;
  getConversationRepo(): ConversationRepository;
  getBasePath(): string;
  setBasePath(path: string): void;
  getVaultEventStore(): VaultEventStore | null;
  setVaultEventStore(store: VaultEventStore): void;
  getReconcilePipeline(): ReconcilePipeline | null;
  getJsonlVaultWatcher(): JsonlVaultWatcher | undefined;
  setJsonlVaultWatcher(watcher: JsonlVaultWatcher | undefined): void;
  wireReconcilePipeline(): void;
  reconcileMissingWorkspaces(): Promise<number>;
  reconcileMissingConversations(): Promise<number>;
  reconcileMissingTasks(): Promise<number>;
}

/**
 * Maintenance & sync surface for HybridStorageAdapter (Phase 2 of
 * docs/plans/hybrid-storage-adapter-split-plan.md).
 *
 * Owns the post-initialization operations: cache rebuild with in-flight
 * coalescing, manual `sync()`, vault-root relocation, the JSONL vault
 * watcher pair, the `external-sync` event emitter, and the three
 * missing-entity reconcilers. The adapter keeps thin public wrappers with
 * identical signatures; this class holds the bodies plus the state that
 * moves with them (`rebuildInFlight`, the `externalEvents` emitter).
 */
export class StorageMaintenanceService {
  /**
   * Coalesces concurrent `rebuildCache` invocations. When a rebuild is in
   * flight, subsequent calls return the same promise so a double-click on
   * "Nexus: Rebuild cache" cannot start two simultaneous rebuilds (which
   * would race over close/remove/initialize/save on `sqliteCache`).
   */
  private rebuildInFlight: Promise<void> | null = null;

  /**
   * Typed event bus for adapter consumers. Currently emits one event:
   *   `external-sync` — payload: { result: SyncResult, modified: ModifiedStream[] }
   * fired after a watcher-triggered sync completes.
   */
  private readonly externalEvents = new Events();

  constructor(private readonly deps: StorageMaintenanceDeps) {}

  /**
   * Wipe the cache backend and rebuild SQLite from the JSONL source of truth.
   * Used by the "Nexus: Rebuild cache" command to recover from a corrupted or
   * out-of-sync cache without touching the (synced) JSONL event store.
   */
  async rebuildCache(options: { onProgress?: (label: string, done: number, total: number) => void } = {}): Promise<void> {
    // Coalesce concurrent invocations. A second click on "Nexus: Rebuild
    // cache" while one is in flight returns the same promise — both callers
    // settle on the same outcome, errors propagate to both.
    if (this.rebuildInFlight) {
      return this.rebuildInFlight;
    }

    this.rebuildInFlight = (async () => {
      try {
        if (!this.deps.getInitLifecycle().isInitialized()) {
          throw new Error('Storage adapter is not initialized; cannot rebuild cache');
        }

        options.onProgress?.('Stopping auto-save', 0, 1);
        this.deps.getSqliteCache().stopAutoSave();

        options.onProgress?.('Closing cache', 0, 1);
        await this.deps.getSqliteCache().close();

        options.onProgress?.('Removing cache blob', 0, 1);
        await this.deps.getCacheBlobStore().remove();

        options.onProgress?.('Reopening cache', 0, 1);
        await this.deps.getSqliteCache().initialize();

        const syncCoordinator = this.deps.getSyncCoordinator();
        if (!syncCoordinator) {
          throw new Error('Sync coordinator unavailable; cannot rebuild from JSONL');
        }

        options.onProgress?.('Rebuilding from JSONL', 0, 1);
        const result = await syncCoordinator.fullRebuild({
          onProgress: options.onProgress
        });

        if (!result.success) {
          const summary = result.errors.length > 0 ? result.errors.join('; ') : 'Unknown error';
          throw new Error(`Cache rebuild failed: ${summary}`);
        }

        options.onProgress?.('Complete', 1, 1);
      } finally {
        // Clear on both success and failure so a follow-up rebuild can
        // re-run; the original error (if any) still rejects this promise.
        this.rebuildInFlight = null;
      }
    })();

    return this.rebuildInFlight;
  }

  /**
   * Subscribe to external-sync events. Fired after the JSONL vault watcher
   * detects a change (e.g. a Sync-pushed JSONL from another device) and
   * the resulting reconciliation has been applied to SQLite. Subscribers
   * use the `modified` stream list to decide whether their currently-viewed
   * content needs to re-query.
   *
   * Returns an Obsidian EventRef. Pass it to `offExternalSync()` (or use
   * the plugin's `registerEvent(ref)` for auto-cleanup on unload).
   */
  onExternalSync(callback: (event: ExternalSyncEvent) => void): EventRef {
    // Obsidian's Events.on takes a variadic `unknown[]` handler; we narrow
    // here by wrapping so callers get a typed API.
    return this.externalEvents.on('external-sync', (...data: unknown[]) => {
      callback(data[0] as ExternalSyncEvent);
    });
  }

  /** Remove a subscription previously added via `onExternalSync`. */
  offExternalSync(ref: EventRef): void {
    this.externalEvents.offref(ref);
  }

  /**
   * Start the JSONL vault watcher. Idempotent. Wires the before-write hook
   * on `JSONLWriter` so self-writes don't echo back as sync triggers.
   */
  startJsonlVaultWatcher(): void {
    if (this.deps.getJsonlVaultWatcher()) {
      return;
    }

    const watcher = new JsonlVaultWatcher({
      app: this.deps.getApp(),
      dataPath: this.deps.getBasePath(),
      onChange: async (modified) => {
        await this.handleExternalJsonlChange(modified);
      }
    });

    this.deps.setJsonlVaultWatcher(watcher);
    this.deps.getJsonlWriter().setBeforeWriteHook((logicalPath) => {
      watcher.suppressLogicalPath(logicalPath);
    });

    watcher.start();
  }

  /**
   * Stop the watcher and tear down its hook. Safe if never started.
   */
  stopJsonlVaultWatcher(): void {
    const watcher = this.deps.getJsonlVaultWatcher();
    if (!watcher) {
      return;
    }
    this.deps.getJsonlWriter().setBeforeWriteHook(undefined);
    watcher.stop();
    this.deps.setJsonlVaultWatcher(undefined);
  }

  /**
   * Reconcile after the watcher detects a modified stream set and emit
   * `external-sync` so open UI can refresh only the affected content.
   * Called by JsonlVaultWatcher's onChange callback.
   *
   * Phase 1 sync-safe reconcile: when the ReconcilePipeline is wired, scope
   * reconcile to the precise streams that fired the modify event instead of
   * sweeping the whole cache. Falls back to a full `sync()` if the pipeline
   * isn't yet wired (e.g. legacy plugin-scoped storage layout) so behavior
   * stays compatible.
   */
  async handleExternalJsonlChange(modified: ModifiedStream[]): Promise<void> {
    if (modified.length === 0) {
      return;
    }
    try {
      let result: SyncResult;
      if (this.deps.getReconcilePipeline()) {
        for (const m of modified) {
          await this.deps.getSyncCoordinator().reconcileStream(m.category, m.streamId);
        }
        await this.runMissingEntityReconcilers();
        this.deps.getQueryCache().clear();
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
        result = await this.sync();
      }
      this.externalEvents.trigger('external-sync', { result, modified } satisfies ExternalSyncEvent);
    } catch (error) {
      console.error('[HybridStorageAdapter] External JSONL change sync failed:', error);
    }
  }

  /**
   * Run the post-sync entity-existence reconcilers (workspaces, conversations,
   * tasks). Mirrors the existing `sync()` post-step so scoped reconcile via
   * `ReconcilePipeline` stays semantically equivalent to the full sweep for
   * cache-fill purposes. Errors are logged but do not propagate.
   */
  private async runMissingEntityReconcilers(): Promise<void> {
    try {
      await Promise.all([
        this.deps.reconcileMissingWorkspaces(),
        this.deps.reconcileMissingConversations(),
        this.deps.reconcileMissingTasks()
      ]);
    } catch (reconcileError) {
      console.error('[HybridStorageAdapter] Post-sync reconciliation failed:', reconcileError);
    }
  }

  async sync(): Promise<SyncResult> {
    try {
      const result = await this.deps.getSyncCoordinator().sync();

      try {
        await Promise.all([
          this.deps.reconcileMissingWorkspaces(),
          this.deps.reconcileMissingConversations(),
          this.deps.reconcileMissingTasks()
        ]);
      } catch (reconcileError) {
        console.error('[HybridStorageAdapter] Post-sync reconciliation failed:', reconcileError);
      }

      // Invalidate all query cache on sync
      this.deps.getQueryCache().clear();

      return result;

    } catch (error) {
      console.error('[HybridStorageAdapter] Sync failed:', error);
      throw error;
    }
  }

  /**
   * Relocate the vault-root event store to a new path.
   *
   * Copies all events from the current store to the destination, verifies
   * integrity, then hot-swaps internal state so all subsequent reads and
   * writes use the new location. Returns `switched: true` only when the
   * swap completed successfully.
   */
  async relocateVaultRoot(
    targetRootPath: string,
    options?: { maxShardBytes?: number }
  ): Promise<VaultRootRelocationResult & { switched: boolean }> {
    const sourceStore = this.deps.getVaultEventStore();
    if (!sourceStore) {
      return {
        success: false,
        verified: false,
        relation: 'conflict',
        durationMs: 0,
        sourceRootPath: '',
        destinationRootPath: targetRootPath,
        sourceStreamCount: 0,
        destinationStreamCountBefore: 0,
        destinationStreamCountAfter: 0,
        copiedEventCount: 0,
        skippedEventCount: 0,
        fileResults: [],
        conflicts: [],
        errors: ['Vault event store is not initialized.'],
        switched: false
      };
    }

    const maxShardBytes = options?.maxShardBytes ?? DEFAULT_STORAGE_SETTINGS.maxShardBytes;

    const relocationService = new VaultRootRelocationService({
      app: this.deps.getApp(),
      sourceStore,
      targetRootPath,
      maxShardBytes
    });

    const result = await relocationService.relocateVaultRoot();

    if (!result.success || !result.verified || !result.destinationStore) {
      return { ...result, switched: false };
    }

    const resolution = resolveVaultRoot(
      { storage: { rootPath: targetRootPath, maxShardBytes } },
      { configDir: this.deps.getApp().vault.configDir }
    );

    this.deps.setVaultEventStore(result.destinationStore);
    this.deps.setBasePath(resolution.dataPath);
    this.deps.getJsonlWriter().setBasePath(resolution.dataPath);
    this.deps.getJsonlWriter().setVaultEventStore(result.destinationStore);
    this.deps.getJsonlWriter().setVaultEventStoreReadEnabled(true);
    this.deps.getJsonlVaultWatcher()?.setDataPath(resolution.dataPath);
    this.deps.wireReconcilePipeline();
    this.deps.getQueryCache().clear();

    return { ...result, switched: true };
  }

  /**
   * Reconcile JSONL workspace files that are missing from SQLite.
   * Handles the case where incremental sync skips same-device events.
   */
  reconcileMissingWorkspaces(): Promise<number> {
    const applier = new WorkspaceEventApplier(this.deps.getSqliteCache());
    const category: ReconcileCategory<WorkspaceEvent> = {
      label: 'workspace',
      subdir: 'workspaces',
      filenameRegex: /workspaces\/ws_(.+)\.jsonl$/,
      existsInCache: async (id) => (await this.deps.getWorkspaceRepo().getById(id)) !== null,
      shouldSkipEvents: (events) => {
        // Skip deletes — no need to create then immediately delete.
        if (events.some(e => e.type === 'workspace_deleted')) return true;
        // Skip files with no workspace_created event (corrupt/incomplete).
        return !events.some(e => e.type === 'workspace_created');
      },
      applyEvent: (e) => applier.apply(e)
    };
    return this.deps.getReconciliationCoordinator().reconcile(category);
  }

  /**
   * Reconcile JSONL conversation files that are missing from SQLite.
   * Handles the case where incremental sync skips remote files whose
   * event timestamps predate the local sync watermark.
   */
  reconcileMissingConversations(): Promise<number> {
    const applier = new ConversationEventApplier(this.deps.getSqliteCache());
    const category: ReconcileCategory<ConversationEvent> = {
      label: 'conversation',
      subdir: 'conversations',
      filenameRegex: /conversations\/conv_(.+)\.jsonl$/,
      existsInCache: async (id) => (await this.deps.getConversationRepo().getById(id)) !== null,
      shouldSkipEvents: (events) => {
        if (events.some(e => e.type === 'conversation_deleted')) return true;
        return !events.some(e => e.type === 'metadata');
      },
      applyEvent: (e) => applier.apply(e)
    };
    return this.deps.getReconciliationCoordinator().reconcile(category);
  }

  /**
   * Reconcile JSONL task files that are missing from SQLite.
   *
   * Note: tasks resolve the workspace id (name → UUID) and probe `projects`
   * directly rather than going through a repository's getById — they are
   * keyed by workspaceId, not entity id, so the standard "exists?" probe
   * is a SQL count instead.
   */
  reconcileMissingTasks(): Promise<number> {
    const applier = new TaskEventApplier(this.deps.getSqliteCache());
    const category: ReconcileCategory<TaskEvent> = {
      label: 'tasks',
      subdir: 'tasks',
      filenameRegex: /tasks\/tasks_(.+)\.jsonl$/,
      existsInCache: async (fileWorkspaceId) => {
        const resolved = await resolveWorkspaceId(fileWorkspaceId, this.deps.getSqliteCache());
        const effectiveId = resolved.id ?? fileWorkspaceId;
        const projects = await this.deps.getSqliteCache().query<{ id: string }>(
          'SELECT id FROM projects WHERE workspaceId = ? LIMIT 1',
          [effectiveId]
        );
        return projects.length > 0;
      },
      shouldSkipEvents: () => false,
      applyEvent: (e) => applier.apply(e)
    };
    return this.deps.getReconciliationCoordinator().reconcile(category);
  }
}
