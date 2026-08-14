/**
 * Deleting a workspace while storage is still hydrating (#333).
 *
 * These drive the real race end to end — delete, then read — rather than
 * asserting on a readiness flag. That matters because the defect was invisible
 * from inside the write: `deleteWorkspace` returned without error, fired its
 * 'deleted' notification, and only the *next read* revealed that nothing had
 * been deleted. A test that stopped at "did it throw?" would have passed
 * against the broken code.
 *
 * The shape of the bug: `withDualBackend` asks `isReady()` and drops to the
 * legacy `<id>.json` path the instant the answer is no — which it is for the
 * whole of startup hydration. The two backends are different stores, so on a
 * vault-root install that write went somewhere nothing reads, while the read
 * path (`withReadableBackend`) waited for the adapter and served the row that
 * was still there.
 */

import type { Plugin } from 'obsidian';
import { WorkspaceService } from '../../src/services/WorkspaceService';
import {
  StorageBackendUnavailableError,
  withWritableBackend
} from '../../src/services/helpers/DualBackendExecutor';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';
import {
  createMockFileSystem,
  createMockIndexManager,
  createMockPlugin
} from '../helpers/mockFactories';

interface StoredWorkspace {
  id: string;
  name: string;
  rootFolder: string;
  created: number;
  lastAccessed: number;
  isActive: boolean;
}

/**
 * An adapter that is the store of record but is not ready yet — the state the
 * plugin is in for the whole of startup hydration.
 *
 * It keeps a real in-memory table so "was it actually deleted?" is a question
 * about stored rows rather than about which mock got called.
 */
function createHydratingAdapter(seed: StoredWorkspace[]) {
  const rows = new Map(seed.map(w => [w.id, w]));
  let ready = false;
  let initError: Error | null = null;
  let releaseReady: (() => void) | undefined;
  const readyPromise = new Promise<void>(resolve => {
    releaseReady = resolve;
  });

  const adapter = {
    isReady: () => ready,
    // Reads route to the adapter on the same signal, so the read in each test
    // is the same read the UI would do.
    isQueryReady: () => ready,
    waitForReady: async () => {
      await readyPromise;
      return ready;
    },
    waitForQueryReady: async () => {
      await readyPromise;
      return ready;
    },
    getInitError: () => initError,

    getWorkspaces: async () => {
      const items = Array.from(rows.values());
      return {
        items,
        page: 0,
        pageSize: items.length,
        totalItems: items.length,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      };
    },
    getWorkspace: async (id: string) => rows.get(id) ?? null,
    createWorkspace: async (data: StoredWorkspace) => {
      rows.set(data.id, data);
      return data.id;
    },
    updateWorkspace: async (id: string, updates: Partial<StoredWorkspace>) => {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, ...updates });
    },
    deleteWorkspace: async (id: string) => {
      rows.delete(id);
    },
    searchWorkspaces: async () => []
  } as unknown as IStorageAdapter;

  return {
    adapter,
    rows,
    /** Hydration finishes successfully — the adapter becomes the live store. */
    finishHydration: () => {
      ready = true;
      releaseReady?.();
    },
    /** Hydration settles as a failure, as it does when a rebuild throws. */
    failHydration: (message: string) => {
      initError = new Error(message);
      releaseReady?.();
    }
  };
}

function createService(adapter: IStorageAdapter | undefined) {
  const plugin = createMockPlugin() as Plugin & { app: { vault: { configDir: string } } };
  plugin.app = { vault: { configDir: '.obsidian', getName: () => 'test' } } as never;
  plugin.manifest.version = '5.0.0';

  const fileSystem = createMockFileSystem();
  const indexManager = createMockIndexManager();

  const service = new WorkspaceService(
    plugin,
    fileSystem as never,
    indexManager as never,
    () => adapter
  );

  return { service, fileSystem, indexManager };
}

const SEED: StoredWorkspace = {
  id: 'ws-doomed',
  name: 'Doomed',
  rootFolder: '/',
  created: 1,
  lastAccessed: 1,
  isActive: true
};

describe('workspace delete during startup hydration (#333)', () => {
  it('stays deleted after hydration finishes, instead of coming back on the next read', async () => {
    const backend = createHydratingAdapter([{ ...SEED }]);
    const { service } = createService(backend.adapter);

    // The user clicks Delete while the plugin is still hydrating.
    expect(backend.adapter.isReady()).toBe(false);
    const deletion = service.deleteWorkspace(SEED.id);

    // Hydration completes a moment later, as it does in the field.
    backend.finishHydration();
    await deletion;

    // The read the UI does next. Pre-fix this returned the workspace: the
    // delete had gone to the legacy store, and the row was untouched.
    const listed = await service.getWorkspaces();
    expect(listed.map(w => w.id)).not.toContain(SEED.id);
    expect(backend.rows.has(SEED.id)).toBe(false);
  });

  it('does not announce a deletion it could not perform', async () => {
    const backend = createHydratingAdapter([{ ...SEED }]);
    const { service } = createService(backend.adapter);

    const events: string[] = [];
    service.onWorkspaceChange(event => events.push(`${event.action}:${event.workspaceId}`));

    const deletion = service.deleteWorkspace(SEED.id);
    backend.failHydration('cache rebuild failed');

    // A notification that outruns its write is what made the UI lie: the row
    // vanished from the list and was back after a reload.
    await expect(deletion).rejects.toThrow(StorageBackendUnavailableError);
    expect(events).toEqual([]);
    expect(backend.rows.has(SEED.id)).toBe(true);
  });

  it('gives up rather than hanging when hydration never settles', async () => {
    // Bound checked on the helper, where the timeout lives, so the test does
    // not have to sit through the production 30s. The point is that the wait
    // ends in an error — swapping #333 for an unbounded hang would just be
    // #158 wearing a different hat.
    const neverSettles = {
      isReady: () => false,
      waitForReady: () => new Promise<boolean>(() => undefined),
      getInitError: () => null
    } as unknown as IStorageAdapter;

    const legacy = jest.fn(async () => 'legacy');

    await expect(
      withWritableBackend(neverSettles, async () => 'adapter', legacy, 25)
    ).rejects.toThrow(StorageBackendUnavailableError);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('still uses the legacy path when there is genuinely no adapter', async () => {
    const { service, fileSystem, indexManager } = createService(undefined);

    await service.deleteWorkspace('ws-legacy-only');

    expect(fileSystem.deleteWorkspace).toHaveBeenCalledWith('ws-legacy-only');
    expect(indexManager.removeWorkspaceFromIndex).toHaveBeenCalledWith('ws-legacy-only');
  });

  it('routes straight through with no wait once hydration is done', async () => {
    const backend = createHydratingAdapter([{ ...SEED }]);
    backend.finishHydration();
    const { service } = createService(backend.adapter);

    await service.deleteWorkspace(SEED.id);

    expect(backend.rows.has(SEED.id)).toBe(false);
  });
});
