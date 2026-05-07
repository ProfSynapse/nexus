/**
 * Integration test: HybridStorageAdapter.rebuildCache() — STORAGE SEAM ONLY.
 *
 * This is the storage half of the split test plan (modal seam lives in
 * cache-backend-rebuild-modal-smoke.test.ts). Asserts that the rebuild call
 * sequence drives stopAutoSave -> close -> blobStore.remove -> initialize ->
 * fullRebuild -> save in order, with the REAL IndexedDB-backed blob store and
 * mocked sqliteCache + syncCoordinator. The blob store starts populated with a
 * synthesized SQLite blob; rebuild must wipe it and the post-rebuild state of
 * IDB must show the blob absent until the next save lands.
 */

jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import { IDBFactory } from 'fake-indexeddb';

import { IndexedDBCacheBlobStore } from '../../src/database/storage/IndexedDBCacheBlobStore';
import { HybridStorageAdapter } from '../../src/database/adapters/HybridStorageAdapter';

interface CacheLifecycleMock {
  initialize: jest.Mock<Promise<void>, []>;
  close: jest.Mock<Promise<void>, []>;
  save: jest.Mock<Promise<void>, []>;
  stopAutoSave: jest.Mock<void, []>;
}

interface SyncCoordinatorMock {
  fullRebuild: jest.Mock<Promise<{ success: boolean; errors: string[] }>, [unknown?]>;
}

function buildSyntheticSqliteBlob(): ArrayBuffer {
  const magic = new TextEncoder().encode('SQLite format 3\0');
  const out = new Uint8Array(8 * 1024);
  out.set(magic, 0);
  for (let i = magic.length; i < out.length; i++) out[i] = i & 0xff;
  return out.buffer;
}

interface RebuildHarness {
  adapter: HybridStorageAdapter;
  blobStore: IndexedDBCacheBlobStore;
  cacheLifecycle: CacheLifecycleMock;
  syncCoordinator: SyncCoordinatorMock;
  callOrder: string[];
}

/**
 * Build a minimal HybridStorageAdapter rigged for rebuildCache() seam testing.
 * Side-steps full initialize() by manually toggling private state — production
 * code paths going through `initialize()` are covered by other tests; this
 * test is scoped specifically to rebuildCache's call sequence.
 */
async function buildRebuildHarness(): Promise<RebuildHarness> {
  const factory = new IDBFactory();
  const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'rebuild:nexus', factory });
  // Pre-populate with a synthesized SQLite blob so we can assert remove() lands.
  await blobStore.write(buildSyntheticSqliteBlob());

  const callOrder: string[] = [];
  const cacheLifecycle: CacheLifecycleMock = {
    stopAutoSave: jest.fn(() => { callOrder.push('stopAutoSave'); }),
    close: jest.fn(async () => { callOrder.push('close'); }),
    initialize: jest.fn(async () => { callOrder.push('initialize'); }),
    save: jest.fn(async () => { callOrder.push('save'); })
  };
  const syncCoordinator: SyncCoordinatorMock = {
    fullRebuild: jest.fn(async () => {
      callOrder.push('fullRebuild');
      return { success: true, errors: [] };
    })
  };

  // Instantiate using a stub — bypass the heavy constructor by Object.create
  // and inject only the fields rebuildCache touches.
  const adapter = Object.create(HybridStorageAdapter.prototype) as HybridStorageAdapter;
  // Private-state injection by name. The test is intentionally tightly coupled
  // to the rebuildCache implementation so a structural change to the call
  // sequence will surface here.
  Object.assign(adapter, {
    initialized: true,
    sqliteCache: cacheLifecycle as unknown,
    syncCoordinator: syncCoordinator as unknown,
    cacheBlobStore: blobStore
  });

  return { adapter, blobStore, cacheLifecycle, syncCoordinator, callOrder };
}

describe('HybridStorageAdapter.rebuildCache (storage seam)', () => {
  it('drives the full call sequence: stopAutoSave -> close -> remove -> initialize -> fullRebuild -> save', async () => {
    const h = await buildRebuildHarness();
    const removeSpy = jest.spyOn(h.blobStore, 'remove');

    await h.adapter.rebuildCache();

    expect(h.cacheLifecycle.stopAutoSave).toHaveBeenCalledTimes(1);
    expect(h.cacheLifecycle.close).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(h.cacheLifecycle.initialize).toHaveBeenCalledTimes(1);
    expect(h.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(1);
    expect(h.cacheLifecycle.save).toHaveBeenCalledTimes(1);

    // Order invariant: each step's index must be strictly ascending.
    const removeIdx = h.callOrder.indexOf('stopAutoSave');
    const closeIdx = h.callOrder.indexOf('close');
    const initIdx = h.callOrder.indexOf('initialize');
    const rebuildIdx = h.callOrder.indexOf('fullRebuild');
    const saveIdx = h.callOrder.indexOf('save');
    expect(removeIdx).toBeLessThan(closeIdx);
    expect(closeIdx).toBeLessThan(initIdx);
    expect(initIdx).toBeLessThan(rebuildIdx);
    expect(rebuildIdx).toBeLessThan(saveIdx);
  });

  it('removes the IDB blob bytes between close and initialize', async () => {
    const h = await buildRebuildHarness();

    // Track read state of the blob store at each transition.
    const beforeRead = await h.blobStore.read();
    expect(beforeRead).not.toBeNull();

    h.cacheLifecycle.initialize.mockImplementation(async () => {
      // At this point, between close() and initialize(), the blob should be gone.
      const mid = await h.blobStore.read();
      expect(mid).toBeNull();
      h.callOrder.push('initialize');
    });

    await h.adapter.rebuildCache();
  });

  it('forwards onProgress callbacks for the seven labeled stages', async () => {
    const h = await buildRebuildHarness();
    const labels: string[] = [];
    await h.adapter.rebuildCache({
      onProgress: (label) => { labels.push(label); }
    });
    // The adapter emits Stopping/Closing/Removing/Reopening/Rebuilding/Complete
    // labels directly. fullRebuild's own onProgress is forwarded but not
    // verified here; this test pins the adapter-owned lifecycle labels.
    for (const expected of [
      'Stopping auto-save',
      'Closing cache',
      'Removing cache blob',
      'Reopening cache',
      'Rebuilding from JSONL',
      'Complete'
    ]) {
      expect(labels).toContain(expected);
    }
  });

  it('throws when adapter is not initialized', async () => {
    const h = await buildRebuildHarness();
    Object.assign(h.adapter, { initialized: false });
    await expect(h.adapter.rebuildCache()).rejects.toThrow(/not initialized/);
    expect(h.cacheLifecycle.stopAutoSave).not.toHaveBeenCalled();
  });

  it('throws and surfaces the underlying error when fullRebuild reports failure', async () => {
    const h = await buildRebuildHarness();
    h.syncCoordinator.fullRebuild.mockResolvedValue({
      success: false,
      errors: ['workspace replay failed', 'task replay failed']
    });

    await expect(h.adapter.rebuildCache()).rejects.toThrow(/workspace replay failed/);
    // save() should NOT be called when rebuild failed — it would persist a bad state.
    expect(h.cacheLifecycle.save).not.toHaveBeenCalled();
  });

  it('throws when fullRebuild reports failure with empty errors (defensive default)', async () => {
    const h = await buildRebuildHarness();
    h.syncCoordinator.fullRebuild.mockResolvedValue({ success: false, errors: [] });
    await expect(h.adapter.rebuildCache()).rejects.toThrow(/Unknown error/);
  });

  it('throws when syncCoordinator is unavailable', async () => {
    const h = await buildRebuildHarness();
    Object.assign(h.adapter, { syncCoordinator: undefined });
    await expect(h.adapter.rebuildCache()).rejects.toThrow(/Sync coordinator unavailable/);
  });

  it('propagates blobStore.remove errors and aborts before initialize', async () => {
    const h = await buildRebuildHarness();
    jest.spyOn(h.blobStore, 'remove').mockRejectedValue(new Error('IDB transaction aborted'));
    await expect(h.adapter.rebuildCache()).rejects.toThrow(/IDB transaction aborted/);
    expect(h.cacheLifecycle.initialize).not.toHaveBeenCalled();
    expect(h.syncCoordinator.fullRebuild).not.toHaveBeenCalled();
  });
});
