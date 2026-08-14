/**
 * Regression tests for the second half of the "no such table: notes" defect:
 * nothing told the notes query index that its database had been thrown away.
 *
 * `rebuildCache()` closes the SQLite connection, deletes the cache blob and
 * reopens a brand-new database, then replays the JSONL event store. That replay
 * restores workspaces, conversations and tasks — it knows nothing about the
 * notes index, whose source is the vault. Before the fix the index was left
 * pointing at tables that no longer existed (every write threw); with the tables
 * now owned by the schema it would instead be left silently EMPTY, answering
 * "no notes" for the rest of the session.
 *
 * These fail against the pre-fix tree: `onCacheRebuilt` and
 * `rebuildAfterCacheReset` did not exist.
 */

import { NotesIndexBuilder } from '../../src/database/services/notesIndex/NotesIndexBuilder';
import { StorageMaintenanceService } from '../../src/database/adapters/lifecycle/StorageMaintenanceService';
import type { NotesIndexService } from '../../src/database/services/notesIndex/NotesIndexService';
import type { StorageMaintenanceDeps } from '../../src/database/adapters/lifecycle/StorageMaintenanceService';

// -- StorageMaintenanceService: does a rebuild announce itself? ---------------

function makeMaintenance(rebuildSucceeds: boolean) {
  const calls: string[] = [];
  const sqliteCache = {
    stopAutoSave: () => calls.push('stopAutoSave'),
    close: () => {
      calls.push('close');
      return Promise.resolve();
    },
    initialize: () => {
      calls.push('initialize');
      return Promise.resolve();
    }
  };
  const cacheBlobStore = {
    remove: () => {
      calls.push('removeBlob');
      return Promise.resolve();
    }
  };
  const syncCoordinator = {
    fullRebuild: () => {
      calls.push('fullRebuild');
      return Promise.resolve({
        success: rebuildSucceeds,
        errors: rebuildSucceeds ? [] : ['boom'],
        eventsApplied: 0,
        conflicts: 0,
        durationMs: 0,
        filesProcessed: []
      });
    }
  };

  const deps = {
    getSqliteCache: () => sqliteCache,
    getCacheBlobStore: () => cacheBlobStore,
    getSyncCoordinator: () => syncCoordinator,
    getInitLifecycle: () => ({ isInitialized: () => true })
  } as unknown as StorageMaintenanceDeps;

  return { service: new StorageMaintenanceService(deps), calls };
}

describe('StorageMaintenanceService cache-rebuilt signal', () => {
  it('recreates the database from scratch, then announces it', async () => {
    const { service, calls } = makeMaintenance(true);
    const seen: string[] = [];
    service.onCacheRebuilt(() => seen.push('rebuilt'));

    await service.rebuildCache();

    // The close -> remove blob -> initialize sequence is exactly why derived
    // tables vanish: the reopened database only has what SCHEMA_SQL creates.
    expect(calls).toEqual(['stopAutoSave', 'close', 'removeBlob', 'initialize', 'fullRebuild']);
    expect(seen).toEqual(['rebuilt']);
  });

  it('does not announce a rebuild that failed', async () => {
    const { service } = makeMaintenance(false);
    const seen: string[] = [];
    service.onCacheRebuilt(() => seen.push('rebuilt'));

    await expect(service.rebuildCache()).rejects.toThrow(/Cache rebuild failed/);
    expect(seen).toEqual([]);
  });

  it('stops notifying after offCacheRebuilt', async () => {
    const { service } = makeMaintenance(true);
    const seen: string[] = [];
    const ref = service.onCacheRebuilt(() => seen.push('rebuilt'));
    service.offCacheRebuilt(ref);

    await service.rebuildCache();
    expect(seen).toEqual([]);
  });
});

// -- NotesIndexBuilder: does it repopulate when told? ------------------------

function makeApp(paths: string[]) {
  const files = paths.map((path) => ({
    path,
    basename: path.replace(/\.md$/, ''),
    extension: 'md',
    parent: { path: '/' },
    stat: { ctime: 1, mtime: 2, size: 3 }
  }));
  return {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
      on: () => ({}),
      offref: () => undefined
    },
    metadataCache: {
      getFileCache: () => ({ frontmatter: {} }),
      on: () => ({}),
      offref: () => undefined
    }
  };
}

function mockService() {
  return {
    ensureSchema: jest.fn().mockResolvedValue(undefined),
    getExistingHashes: jest.fn().mockResolvedValue(new Map()),
    upsertNote: jest.fn().mockResolvedValue(undefined),
    deleteNote: jest.fn().mockResolvedValue(undefined),
    pruneMissing: jest.fn().mockResolvedValue(undefined)
  };
}

describe('NotesIndexBuilder.rebuildAfterCacheReset', () => {
  it('re-issues the schema and re-walks the vault', async () => {
    const service = mockService();
    const builder = new NotesIndexBuilder(
      makeApp(['a.md', 'b.md']) as never,
      service as unknown as NotesIndexService
    );

    await builder.rebuildAfterCacheReset();

    expect(service.ensureSchema).toHaveBeenCalledTimes(1);
    // Every note is re-upserted: the fresh database has no rows, so the
    // hash-gated skip has nothing to skip.
    expect(service.upsertNote).toHaveBeenCalledTimes(2);
    expect(builder.isReady()).toBe(true);
  });

  it('logs and clears readiness instead of throwing when the rebuild fails', async () => {
    const service = mockService();
    service.getExistingHashes.mockRejectedValue(new Error('no such table: notes'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const builder = new NotesIndexBuilder(
      makeApp(['a.md']) as never,
      service as unknown as NotesIndexService
    );

    // Called from an event handler, so it must never reject.
    await expect(builder.rebuildAfterCacheReset()).resolves.toBeUndefined();
    expect(builder.isReady()).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
