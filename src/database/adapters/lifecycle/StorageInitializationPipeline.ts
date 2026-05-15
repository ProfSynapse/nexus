/**
 * Storage adapter startup saga.
 *
 * Was the body of `HybridStorageAdapter.performInitialization` (~75 lines
 * of multi-step orchestration). Steps run in order:
 *
 *   1. LegacyMigrator (detect + run if needed)
 *   2. StorageCoordinator.prepareStoragePlan
 *   3. StoragePlanApplier.applyStoragePlan
 *   4. StoragePlanApplier.backfillVaultEventStore
 *   5. StoragePlanApplier.runCacheBackendMigration
 *   6. SQLiteCacheManager.initialize
 *   7. Build ReconciliationCoordinator
 *   8. Hydration blocking decision
 *   9. ensureDirectory * 3
 *  10. fullRebuild OR incremental sync + per-category reconcile
 *  11. Hydration complete
 *  12. Start the external JSONL watcher
 *
 * Each step is small. The pipeline doesn't hide them — they read top-to-
 * bottom in `run()`. The win over the inline version is dependency
 * narrowing: the adapter doesn't import LegacyMigrator, the migration
 * services, or the hydration logic anymore.
 */

import { App } from 'obsidian';
import { JSONLWriter } from '../../storage/JSONLWriter';
import { SQLiteCacheManager } from '../../storage/SQLiteCacheManager';
import { SyncCoordinator } from '../../sync/SyncCoordinator';
import { PluginScopedStorageCoordinator } from '../../migration/PluginScopedStorageCoordinator';
import { LegacyMigrator } from '../../migration/LegacyMigrator';
import { StartupHydrationController } from './StartupHydrationController';
import { StoragePlanApplier } from './StoragePlanApplier';
import { ReconciliationCoordinator } from './ReconciliationCoordinator';
import { MissingEntityReconcilerRunner } from './MissingEntityReconcilers';

export interface StorageInitializationPipelineDeps {
  app: App;
  jsonlWriter: JSONLWriter;
  sqliteCache: SQLiteCacheManager;
  syncCoordinator: SyncCoordinator;
  storageCoordinator: PluginScopedStorageCoordinator;
  hydration: StartupHydrationController;
  planApplier: StoragePlanApplier;
  reconcilers: MissingEntityReconcilerRunner;
  /**
   * The pipeline produces a ReconciliationCoordinator after SQLite is
   * open; the adapter holds the reference so the missing-entity
   * reconcilers can resolve it lazily.
   */
  onReconciliationCoordinatorReady: (coord: ReconciliationCoordinator) => void;
  /** Hook to start the JSONL vault watcher once init is done. */
  startExternalSyncWatcher: () => void;
}

export class StorageInitializationPipeline {
  constructor(private readonly deps: StorageInitializationPipelineDeps) {}

  async run(): Promise<void> {
    const { app, jsonlWriter, sqliteCache, syncCoordinator, storageCoordinator,
      hydration, planApplier, reconcilers, onReconciliationCoordinatorReady,
      startExternalSyncWatcher } = this.deps;

    const migrator = new LegacyMigrator(app);
    const migrationNeeded = await migrator.isMigrationNeeded();
    let actuallyMigrated = false;

    if (migrationNeeded) {
      const migrationResult = await migrator.migrate();
      actuallyMigrated = migrationResult.needed &&
        (migrationResult.stats.workspacesMigrated > 0 ||
         migrationResult.stats.conversationsMigrated > 0);
    }

    let storagePlan = await storageCoordinator.prepareStoragePlan();
    planApplier.applyStoragePlan(storagePlan);
    storagePlan = await planApplier.backfillVaultEventStore(storagePlan);

    // Cache-backend migration must run BEFORE sqliteCache.initialize() so
    // the cache manager loads bytes from the destination backend.
    await planApplier.runCacheBackendMigration(storagePlan);

    await sqliteCache.initialize();
    const coord = new ReconciliationCoordinator(jsonlWriter, sqliteCache);
    onReconciliationCoordinatorReady(coord);

    const shouldBlock = await planApplier.shouldBlockStartupHydration(storagePlan);
    if (shouldBlock) {
      hydration.startBlocking();
    } else {
      hydration.clear();
    }

    await jsonlWriter.ensureDirectory('workspaces');
    await jsonlWriter.ensureDirectory('conversations');
    await jsonlWriter.ensureDirectory('tasks');

    const syncState = await sqliteCache.getSyncState(jsonlWriter.getDeviceId());
    if (!syncState || actuallyMigrated || shouldBlock) {
      try {
        await syncCoordinator.fullRebuild({
          onProgress: (stage, progress, total) => {
            hydration.updateProgress(stage, progress, total, shouldBlock);
          }
        });
      } catch (rebuildError) {
        console.error('[HybridStorageAdapter] Full rebuild failed:', rebuildError);
        hydration.fail(rebuildError instanceof Error ? rebuildError.message : String(rebuildError));
      }
    } else {
      try {
        await syncCoordinator.sync();
      } catch (syncError) {
        console.error('[HybridStorageAdapter] Incremental sync failed:', syncError);
      }
      await reconcilers.runAllSequential();
    }

    if (shouldBlock && hydration.getState().phase !== 'error') {
      hydration.complete();
    }

    startExternalSyncWatcher();
  }
}
