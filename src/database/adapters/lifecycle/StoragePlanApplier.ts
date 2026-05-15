/**
 * Owns the storage-plan side of init: applying the resolved plan to the
 * writer + cache, backfilling the vault event store, running the cache
 * backend migration, deciding whether startup hydration should block.
 *
 * Each method is invoked by the InitializationPipeline; they're also kept
 * reachable from HybridStorageAdapter as thin pass-throughs because the
 * unit tests pin private method names (applyStoragePlan,
 * runCacheBackendMigration). New code should call this class directly.
 */

import { App } from 'obsidian';
import { JSONLWriter } from '../../storage/JSONLWriter';
import { SQLiteCacheManager } from '../../storage/SQLiteCacheManager';
import { SyncCoordinator } from '../../sync/SyncCoordinator';
import { ReconcilePipeline } from '../../sync/ReconcilePipeline';
import { VaultEventStore } from '../../storage/vaultRoot/VaultEventStore';
import { VaultRootMigrationService } from '../../migration/VaultRootMigrationService';
import {
  PluginScopedStorageCoordinator,
  PluginScopedStoragePlan
} from '../../migration/PluginScopedStorageCoordinator';
import { CacheBackendMigration, type CacheBackendStateAccessor } from '../../migration/CacheBackendMigration';
import type { CacheBlobStore } from '../../storage/CacheBlobStore';
import { isDesktop } from '../../../utils/platform';
import { shouldBlockStartupHydrationForVerifiedCutover } from './StartupHydrationController';

export interface StoragePlanApplierDeps {
  app: App;
  jsonlWriter: JSONLWriter;
  sqliteCache: SQLiteCacheManager;
  syncCoordinator: SyncCoordinator;
  storageCoordinator: PluginScopedStorageCoordinator;
  cacheBlobStore: CacheBlobStore;
  /** Called with the new event store after applyStoragePlan / relocate. */
  onVaultEventStoreChanged: (store: VaultEventStore | null) => void;
  /** Called with the new base path so the adapter can mirror it. */
  onBasePathChanged: (path: string) => void;
}

export class StoragePlanApplier {
  private vaultEventStore: VaultEventStore | null = null;
  private reconcilePipeline: ReconcilePipeline | null = null;

  constructor(private readonly deps: StoragePlanApplierDeps) {}

  getVaultEventStore(): VaultEventStore | null {
    return this.vaultEventStore;
  }

  getReconcilePipeline(): ReconcilePipeline | null {
    return this.reconcilePipeline;
  }

  /**
   * Apply the resolved plan to JSONLWriter + SQLite, instantiate the
   * VaultEventStore for the chosen root, and wire the reconcile pipeline.
   */
  applyStoragePlan(plan: PluginScopedStoragePlan): void {
    const { jsonlWriter, sqliteCache, app, onVaultEventStoreChanged, onBasePathChanged } = this.deps;

    onBasePathChanged(plan.vaultWriteBasePath);

    this.vaultEventStore = new VaultEventStore({ app, resolution: plan.vaultRoot });
    onVaultEventStoreChanged(this.vaultEventStore);

    jsonlWriter.setBasePath(plan.vaultWriteBasePath);
    jsonlWriter.setReadBasePaths(plan.legacyReadBasePaths);
    jsonlWriter.setVaultEventStore(this.vaultEventStore);
    jsonlWriter.setVaultEventStoreReadEnabled(
      plan.state.migration.state === 'verified' || plan.state.migration.state === 'not_needed'
    );
    sqliteCache.setDbPath(plan.pluginCacheDbPath);
    this.wireReconcilePipeline();
  }

  /**
   * Construct the sync-safe reconcile pipeline once `vaultEventStore` is
   * available and inject it into the SyncCoordinator. Idempotent: replaces
   * any existing pipeline so cursor state from an old root is dropped.
   */
  wireReconcilePipeline(): void {
    const { syncCoordinator, sqliteCache, jsonlWriter } = this.deps;
    if (!this.vaultEventStore) {
      this.reconcilePipeline = null;
      syncCoordinator.setReconcilePipeline(null);
      return;
    }
    const appliers = syncCoordinator.getAppliers();
    this.reconcilePipeline = new ReconcilePipeline({
      vaultEventStore: this.vaultEventStore,
      syncStateStore: sqliteCache.getSyncStateStore(),
      sqliteCache,
      workspaceApplier: appliers.workspace,
      conversationApplier: appliers.conversation,
      taskApplier: appliers.task,
      deviceId: jsonlWriter.getDeviceId()
    });
    syncCoordinator.setReconcilePipeline(this.reconcilePipeline);
  }

  /**
   * Replace the active VaultEventStore (used after `relocateVaultRoot`
   * verifies the destination). Rewires the reconcile pipeline so cursor
   * state from the old store is dropped.
   */
  swapVaultEventStore(store: VaultEventStore): void {
    this.vaultEventStore = store;
    this.deps.onVaultEventStoreChanged(store);
    this.wireReconcilePipeline();
  }

  /**
   * Cache-backend migration (cache.db file → IndexedDB on desktop). Runs
   * foreground-blocking with a Notice; mobile bypasses immediately. Must
   * execute BEFORE sqliteCache.initialize() so the cache manager loads
   * bytes from the destination backend, not the legacy file.
   */
  async runCacheBackendMigration(plan: PluginScopedStoragePlan): Promise<void> {
    const { app, storageCoordinator, cacheBlobStore } = this.deps;
    const accessor: CacheBackendStateAccessor = {
      read: () => storageCoordinator.readCacheBackendState(),
      write: (state) => storageCoordinator.writeCacheBackendState(state)
    };
    const migration = new CacheBackendMigration({
      adapter: app.vault.adapter,
      legacyDbPath: plan.pluginCacheDbPath,
      pluginDataRoot: plan.roots.dataRoot,
      blobStore: cacheBlobStore,
      stateAccessor: accessor,
      isMobile: !isDesktop()
    });
    await migration.runIfNeeded();
  }

  /**
   * Backfill the VaultEventStore from legacy plugin-data roots when the
   * migration is pending. Always returns the (possibly updated) plan.
   */
  async backfillVaultEventStore(plan: PluginScopedStoragePlan): Promise<PluginScopedStoragePlan> {
    if (plan.state.migration.state !== 'pending' || !this.vaultEventStore) {
      return plan;
    }
    const { app, storageCoordinator, jsonlWriter } = this.deps;

    try {
      const migrationService = new VaultRootMigrationService({
        app,
        vaultEventStore: this.vaultEventStore,
        legacyRoots: plan.legacyReadBasePaths
      });
      const result = await migrationService.backfillLegacyRoots();

      if (result.success && result.verified) {
        const nextState = await storageCoordinator.persistMigrationState(plan, 'verified', {
          completedAt: Date.now(),
          verifiedAt: Date.now()
        });
        jsonlWriter.setVaultEventStoreReadEnabled(true);
        return { ...plan, state: nextState };
      }

      const failureMessage = result.errors[0] ?? result.message;
      const nextState = await storageCoordinator.persistMigrationState(plan, 'failed', {
        completedAt: Date.now(),
        lastError: failureMessage
      });
      return { ...plan, state: nextState };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextState = await storageCoordinator.persistMigrationState(plan, 'failed', {
        completedAt: Date.now(),
        lastError: message
      });
      return { ...plan, state: nextState };
    }
  }

  /**
   * Decide whether startup hydration should block based on the verified
   * cutover invariants. See `shouldBlockStartupHydrationForVerifiedCutover`.
   */
  async shouldBlockStartupHydration(plan: PluginScopedStoragePlan): Promise<boolean> {
    const { jsonlWriter, sqliteCache } = this.deps;
    const conversationFiles = await jsonlWriter.listFiles('conversations');
    const stats = await sqliteCache.getStatistics();
    return shouldBlockStartupHydrationForVerifiedCutover({
      migrationState: plan.state.migration.state,
      sourceOfTruthLocation: plan.state.sourceOfTruthLocation,
      conversationFileCount: conversationFiles.length,
      cachedConversationCount: stats.conversations,
      cachedMessageCount: stats.messages
    });
  }
}
