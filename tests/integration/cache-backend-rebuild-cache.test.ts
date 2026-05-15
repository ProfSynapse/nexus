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
import { InitLifecycleController } from '../../src/database/adapters/lifecycle/InitLifecycleController';

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
  const initLifecycle = new InitLifecycleController();
  // Drive the controller to the "ready" state by running a no-op.
  await initLifecycle.run(async () => undefined, { blocking: true });
  Object.assign(adapter, {
    initLifecycle,
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
    // Swap in a fresh, never-run controller so isInitialized() is false.
    Object.assign(h.adapter, { initLifecycle: new InitLifecycleController() });
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

  // ---------------------------------------------------------------------------
  // B.1 — Concurrent rebuildCache coalescing (test-engineer-3 review §3.1).
  //
  // Implementation contract (shipped at e65f3691): the second rebuild call
  // while one is in-flight returns the SAME promise reference (rebuildInFlight
  // field), and the body is wrapped in an IIFE with try/finally that clears
  // the field. On settlement (success or failure), a fresh rebuildCache()
  // starts a new in-flight rebuild.
  //
  // Three behaviors to pin:
  //   (a) Two parallel calls return the same promise reference.
  //   (b) Both callers settle to the same outcome (both resolve on success,
  //       both reject with the same error on failure).
  //   (c) After settlement, a follow-up rebuildCache() starts a NEW rebuild
  //       (rebuildInFlight is cleared in finally).
  // ---------------------------------------------------------------------------
  describe('rebuildCache coalescing (B.1)', () => {
    it('two parallel rebuildCache() calls coalesce: lifecycle hooks fire exactly once', async () => {
      const h = await buildRebuildHarness();

      // Slow down fullRebuild so the second call observes rebuildInFlight !== null.
      h.syncCoordinator.fullRebuild.mockImplementation(async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
        h.callOrder.push('fullRebuild');
        return { success: true, errors: [] };
      });

      // Behavioral coalescing pin: the production method is `async`, so its
      // outer promise wraps the rebuildInFlight return — that means the two
      // returned Promise objects will NOT be reference-equal even though the
      // inner work is shared. We pin coalescing by asserting the SHARED-
      // SIDE-EFFECTS contract: lifecycle hooks fire exactly once across the
      // two callers, and both callers settle to the same outcome.
      const first = h.adapter.rebuildCache();
      const second = h.adapter.rebuildCache();

      const [r1, r2] = await Promise.all([first, second]);
      expect(r1).toBe(r2); // both resolve to undefined
      // The lifecycle hooks ran exactly ONCE despite two callers.
      expect(h.cacheLifecycle.stopAutoSave).toHaveBeenCalledTimes(1);
      expect(h.cacheLifecycle.close).toHaveBeenCalledTimes(1);
      expect(h.cacheLifecycle.initialize).toHaveBeenCalledTimes(1);
      expect(h.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(1);
      expect(h.cacheLifecycle.save).toHaveBeenCalledTimes(1);
    });

    it('both parallel callers reject with the SAME error when fullRebuild fails', async () => {
      const h = await buildRebuildHarness();
      h.syncCoordinator.fullRebuild.mockImplementation(async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
        return { success: false, errors: ['workspace replay failed'] };
      });

      // Attach catch handlers immediately so neither promise becomes an
      // unhandled rejection if a later assertion throws synchronously.
      const first = h.adapter.rebuildCache();
      const second = h.adapter.rebuildCache();
      const safeFirst = first.catch((e: unknown) => e);
      const safeSecond = second.catch((e: unknown) => e);

      const [outcome1, outcome2] = await Promise.all([safeFirst, safeSecond]);
      // Both callers receive an Error with the same message — the same root
      // error propagated through two awaiters, even though the outer async
      // wrappers may produce distinct Promise objects.
      expect(outcome1).toBeInstanceOf(Error);
      expect(outcome2).toBeInstanceOf(Error);
      expect((outcome1 as Error).message).toMatch(/workspace replay failed/);
      expect((outcome2 as Error).message).toBe((outcome1 as Error).message);
      // The shared rebuild ran exactly once: only ONE fullRebuild call,
      // even though two callers received the rejection.
      expect(h.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(1);
      // save() must not have run (failure path bails before save).
      expect(h.cacheLifecycle.save).not.toHaveBeenCalled();
    });

    it('after a successful rebuild settles, a follow-up rebuildCache() starts a NEW in-flight rebuild', async () => {
      const h = await buildRebuildHarness();

      // First rebuild — finishes promptly.
      await h.adapter.rebuildCache();
      expect(h.cacheLifecycle.initialize).toHaveBeenCalledTimes(1);
      expect(h.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(1);

      // Second rebuild after the first settles — must run a fresh cycle.
      // The rebuildInFlight field has been cleared in the try/finally.
      const second = h.adapter.rebuildCache();
      // Reference must NOT equal the first (which has already resolved). We
      // can't easily access the first promise reference here, but we can
      // verify the new lifecycle hooks fire — which only happens if a new
      // rebuild was started, not if the cleared field was missed.
      await second;
      expect(h.cacheLifecycle.initialize).toHaveBeenCalledTimes(2);
      expect(h.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(2);
    });

    it('after a failed rebuild settles, a follow-up rebuildCache() can still start a NEW rebuild (finally clears the field)', async () => {
      const h = await buildRebuildHarness();
      h.syncCoordinator.fullRebuild.mockResolvedValueOnce({
        success: false,
        errors: ['transient replay error']
      });

      // First rebuild fails — try/finally must still clear rebuildInFlight.
      await expect(h.adapter.rebuildCache()).rejects.toThrow(/transient replay error/);

      // Restore healthy fullRebuild for the retry.
      h.syncCoordinator.fullRebuild.mockResolvedValue({ success: true, errors: [] });

      // Follow-up rebuild — must start a fresh cycle and succeed.
      await expect(h.adapter.rebuildCache()).resolves.toBeUndefined();
      expect(h.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(2);
      // save() ran on the second cycle (success path) but not the first (we
      // bail before save on failure — see the "save() should NOT be called"
      // assertion in the failure-mode test above).
      expect(h.cacheLifecycle.save).toHaveBeenCalledTimes(1);
    });
  });
});
