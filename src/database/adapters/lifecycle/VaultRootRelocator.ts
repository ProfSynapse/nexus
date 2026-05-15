/**
 * Orchestrates `HybridStorageAdapter.relocateVaultRoot`: invokes the
 * VaultRootRelocationService to copy + verify the destination, then
 * hot-swaps adapter state (vaultEventStore, basePath, writer paths,
 * watcher data path, reconcile pipeline) so all subsequent reads + writes
 * use the new location.
 */

import { App } from 'obsidian';
import { JSONLWriter } from '../../storage/JSONLWriter';
import { QueryCache } from '../../optimizations/QueryCache';
import {
  VaultRootRelocationService,
  type VaultRootRelocationResult
} from '../../migration/VaultRootRelocationService';
import { resolveVaultRoot } from '../../storage/VaultRootResolver';
import { DEFAULT_STORAGE_SETTINGS } from '../../../types/plugin/PluginTypes';
import { StoragePlanApplier } from './StoragePlanApplier';
import { ExternalSyncController } from './ExternalSyncController';

export interface VaultRootRelocatorDeps {
  app: App;
  jsonlWriter: JSONLWriter;
  queryCache: QueryCache;
  planApplier: StoragePlanApplier;
  externalSync: ExternalSyncController;
  onBasePathChanged: (path: string) => void;
}

export type VaultRootRelocationOutcome = VaultRootRelocationResult & { switched: boolean };

export class VaultRootRelocator {
  constructor(private readonly deps: VaultRootRelocatorDeps) {}

  async relocate(
    targetRootPath: string,
    options?: { maxShardBytes?: number }
  ): Promise<VaultRootRelocationOutcome> {
    const sourceStore = this.deps.planApplier.getVaultEventStore();
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
      app: this.deps.app,
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
      { configDir: this.deps.app.vault.configDir }
    );

    // Hot-swap: planApplier owns the vault event store + reconcile pipeline;
    // adapter mirrors basePath; jsonlWriter / watcher / queryCache get
    // refreshed in place.
    this.deps.planApplier.swapVaultEventStore(result.destinationStore);
    this.deps.onBasePathChanged(resolution.dataPath);
    this.deps.jsonlWriter.setBasePath(resolution.dataPath);
    this.deps.jsonlWriter.setVaultEventStore(result.destinationStore);
    this.deps.jsonlWriter.setVaultEventStoreReadEnabled(true);
    this.deps.externalSync.setDataPath(resolution.dataPath);
    this.deps.queryCache.clear();

    return { ...result, switched: true };
  }
}
