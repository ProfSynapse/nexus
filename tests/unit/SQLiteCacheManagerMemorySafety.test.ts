jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import type { App } from 'obsidian';

import { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import { SQLitePersistenceService } from '../../src/database/storage/SQLitePersistenceService';
import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';

function harness() {
  let inTransaction = false;
  let exported = 0;
  const dbHandle = { exec: jest.fn(), prepare: jest.fn(), close: jest.fn(), changes: jest.fn(() => 0), selectValue: jest.fn(() => 'ok') };
  const cloneHandle = { ...dbHandle, close: jest.fn() };
  const sqlite3 = { oo1: {}, wasm: {}, capi: {} };
  const bridge = {
    exportDatabase: jest.fn(() => { exported++; return new ArrayBuffer(16); }),
    cloneDatabase: jest.fn(() => cloneHandle),
    deserializeDatabase: jest.fn(() => dbHandle),
    isAutocommit: jest.fn(() => !inTransaction),
    exec: jest.fn(),
    run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
    query: jest.fn(() => []),
    queryOne: jest.fn(() => null),
    close: jest.fn()
  };
  const blobStore = { read: jest.fn(), write: jest.fn(async () => undefined), remove: jest.fn(), getMetadata: jest.fn() };
  const manager = new SQLiteCacheManager({
    app: { vault: { configDir: '.obsidian', adapter: {} } } as unknown as App,
    dbPath: '.nexus/data/cache.db',
    autoSaveInterval: 0,
    blobStore: blobStore as unknown as CacheBlobStore
  });
  const internals = manager as unknown as Record<string, unknown>;
  internals.bridge = bridge;
  internals.db = dbHandle;
  internals.sqlite3 = sqlite3;
  internals.isInitialized = true;
  internals.persistenceService = new SQLitePersistenceService({
    blobStore: blobStore as unknown as CacheBlobStore,
    bridge: bridge as unknown as ConstructorParameters<typeof SQLitePersistenceService>[0]['bridge']
  });
  return {
    manager, bridge, cloneHandle,
    exported: () => exported,
    setInTransaction: (v: boolean) => { inTransaction = v; },
    internals
  };
}

describe('SQLiteCacheManager memory-safe save and planning clone', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not export while a transaction is open, and exports once it ends', async () => {
    const h = harness();
    h.setInTransaction(true);
    (h.manager as unknown as { markDirty(): void }).markDirty();
    const saving = h.manager.save();
    await jest.advanceTimersByTimeAsync(200);
    expect(h.exported()).toBe(0);
    h.setInTransaction(false);
    await jest.advanceTimersByTimeAsync(100);
    await saving;
    expect(h.exported()).toBe(1);
    expect(h.manager.hasUnsavedChanges()).toBe(false);
  });

  it('defers instead of exporting a transaction that outlives the wait, stays dirty, and retries', async () => {
    const h = harness();
    h.setInTransaction(true);
    (h.manager as unknown as { markDirty(): void }).markDirty();
    const saving = h.manager.save();
    const outcome = saving.then(() => 'resolved', (error: Error) => error.message);
    await jest.advanceTimersByTimeAsync(6000);
    // A resolved save means the bytes were written; a deferred one must not resolve.
    expect(await outcome).toContain('Save deferred: a transaction is still open');
    expect(h.exported()).toBe(0);
    expect(h.manager.hasUnsavedChanges()).toBe(true);
    expect(h.internals.nextAutoSaveAttemptAt).toBe(0);
    h.setInTransaction(false);
    await jest.advanceTimersByTimeAsync(1500);
    expect(h.exported()).toBe(1);
    expect(h.manager.hasUnsavedChanges()).toBe(false);
  });


  it('still closes the database when a transaction outlives the final save', async () => {
    const h = harness();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    h.setInTransaction(true);
    (h.manager as unknown as { markDirty(): void }).markDirty();
    const closing = h.manager.close();
    await jest.advanceTimersByTimeAsync(6000);
    await closing;
    expect(h.exported()).toBe(0);
    expect(h.bridge.close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Closing with a transaction still open'), expect.anything());
    await jest.advanceTimersByTimeAsync(2000);
    expect(h.exported()).toBe(0);
    error.mockRestore();
  });
});
