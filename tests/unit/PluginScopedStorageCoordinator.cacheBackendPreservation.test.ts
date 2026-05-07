/**
 * Regression test for v5.8.13 hotfix.
 *
 * Bug: PluginScopedStorageCoordinator.saveState() did
 *   pluginData.pluginStorage = state
 * which clobbered the persisted cacheBackend record on every boot.
 * On Windows, where the cache-backend JANITOR could not delete cache.db
 * (filesystem-watcher lock), the cache-backend migration FSM re-ran on
 * every restart because runCacheBackendMigration read pluginStorage.cacheBackend
 * as undefined → fell through legacyExists=true → ran the full FSM.
 *
 * Fix: saveState() now merges existing cacheBackend across the JSONL-state write.
 *
 * These tests exercise saveState() through the public prepareStoragePlan()
 * and persistMigrationState() entry points (saveState is private).
 */

import { PluginScopedStorageCoordinator } from '../../src/database/migration/PluginScopedStorageCoordinator';
import { createMockApp } from '../helpers/mockVaultAdapter';

interface MinimalPluginStorage {
  storageVersion: number;
  sourceOfTruthLocation: string;
  migration: {
    state: string;
    legacySourcesDetected: string[];
    activeDestination: string;
  };
  cacheBackend?: {
    backend: 'idb' | 'file';
    migrationState: 'verified' | 'pending' | 'failed' | 'not_needed';
    migratedAt?: number;
    lastError?: string;
  };
}

interface SavedData {
  pluginStorage?: MinimalPluginStorage;
  storage?: { rootPath: string; maxShardBytes: number; schemaVersion: number };
}

describe('PluginScopedStorageCoordinator — cacheBackend preservation', () => {
  it('preserves existing cacheBackend across prepareStoragePlan() saveState write', async () => {
    const { app } = createMockApp({ configDir: '.obsidian' });

    // Pre-existing pluginData with a verified cacheBackend record (the post-PR-#202
    // steady state on a healthy install). prepareStoragePlan() will write a
    // fresh JSONL-migration state, which previously dropped this field.
    const initialPluginData: SavedData = {
      storage: {
        rootPath: 'storage/assistant-data',
        maxShardBytes: 2_097_152,
        schemaVersion: 3
      },
      pluginStorage: {
        storageVersion: 2,
        sourceOfTruthLocation: 'vault-root',
        migration: {
          state: 'not_needed',
          legacySourcesDetected: [],
          activeDestination: 'storage/assistant-data/data'
        },
        cacheBackend: {
          backend: 'idb',
          migrationState: 'verified',
          migratedAt: 1234567890
        }
      }
    };

    const saveData = jest.fn(async (next: SavedData) => {
      // Simulate the disk: subsequent loadData() calls see the latest write.
      Object.assign(initialPluginData, next);
    });
    const loadData = jest.fn(async () => ({ ...initialPluginData }));

    const coordinator = new PluginScopedStorageCoordinator(
      app as never,
      {
        manifest: {
          id: 'nexus',
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        },
        loadData,
        saveData
      } as never,
      '.nexus'
    );

    await coordinator.prepareStoragePlan();

    expect(saveData).toHaveBeenCalled();
    const lastCallIdx = saveData.mock.calls.length - 1;
    const savedPluginStorage = saveData.mock.calls[lastCallIdx][0].pluginStorage;
    expect(savedPluginStorage).toBeDefined();

    // The critical assertion: cacheBackend MUST survive the saveState write,
    // identical to the pre-existing record.
    expect(savedPluginStorage?.cacheBackend).toEqual({
      backend: 'idb',
      migrationState: 'verified',
      migratedAt: 1234567890
    });

    // Sanity: the new JSONL-migration state was applied (the merge isn't
    // discarding the new state — only preserving cacheBackend).
    expect(savedPluginStorage?.storageVersion).toBe(2);
    expect(savedPluginStorage?.migration.state).toBe('not_needed');
  });

  it('preserves cacheBackend across persistMigrationState() writes', async () => {
    const { app } = createMockApp({
      configDir: '.obsidian',
      initialFiles: {
        '.nexus/conversations/conv_alpha.jsonl': '{"id":"legacy-evt"}\n'
      }
    });

    // Disk state: a verified cacheBackend coexists with a pending JSONL migration.
    const initialPluginData: SavedData = {
      pluginStorage: {
        storageVersion: 2,
        sourceOfTruthLocation: 'legacy-dotnexus',
        migration: {
          state: 'pending',
          legacySourcesDetected: ['.nexus'],
          activeDestination: 'Nexus/data'
        },
        cacheBackend: {
          backend: 'idb',
          migrationState: 'verified',
          migratedAt: 9999999999
        }
      }
    };

    const saveData = jest.fn(async (next: SavedData) => {
      Object.assign(initialPluginData, next);
    });
    const loadData = jest.fn(async () => ({ ...initialPluginData }));

    const coordinator = new PluginScopedStorageCoordinator(
      app as never,
      {
        manifest: {
          id: 'nexus',
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        },
        loadData,
        saveData
      } as never,
      '.nexus'
    );

    const plan = await coordinator.prepareStoragePlan();
    await coordinator.persistMigrationState(plan, 'verified', {
      completedAt: 1000,
      verifiedAt: 2000
    });

    // Inspect the LAST saveData write (from persistMigrationState).
    const last = saveData.mock.calls[saveData.mock.calls.length - 1][0];
    expect(last.pluginStorage?.migration.state).toBe('verified');
    // cacheBackend must still be intact after the verified write.
    expect(last.pluginStorage?.cacheBackend).toEqual({
      backend: 'idb',
      migrationState: 'verified',
      migratedAt: 9999999999
    });
  });

  it('writes no spurious cacheBackend when none was previously persisted', async () => {
    // Inverse case: a fresh install with no prior cacheBackend record. saveState
    // should NOT inject an empty cacheBackend object — the field stays absent
    // until the cache-backend FSM writes it.
    const { app } = createMockApp({ configDir: '.obsidian' });

    const initialPluginData: SavedData = {
      storage: {
        rootPath: 'storage/assistant-data',
        maxShardBytes: 2_097_152,
        schemaVersion: 3
      }
      // pluginStorage is undefined — first boot, no prior state.
    };

    const saveData = jest.fn(async (next: SavedData) => {
      Object.assign(initialPluginData, next);
    });
    const loadData = jest.fn(async () => ({ ...initialPluginData }));

    const coordinator = new PluginScopedStorageCoordinator(
      app as never,
      {
        manifest: {
          id: 'nexus',
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        },
        loadData,
        saveData
      } as never,
      '.nexus'
    );

    await coordinator.prepareStoragePlan();

    const lastCallIdx = saveData.mock.calls.length - 1;
    const savedPluginStorage = saveData.mock.calls[lastCallIdx][0].pluginStorage;
    expect(savedPluginStorage).toBeDefined();
    // cacheBackend should NOT exist on the saved record (no prior value to preserve).
    expect(savedPluginStorage?.cacheBackend).toBeUndefined();
  });
});
