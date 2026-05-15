/**
 * Integration test: HybridStorageAdapter.runCacheBackendMigration parameter
 * wiring (test-engineer-3 review §T2.1).
 *
 * The reviewer's literal phrasing was "construct a real (or thinly-stubbed)
 * HybridStorageAdapter ... assert that runCacheBackendMigration wires the four
 * parameters correctly." We spy on CacheBackendMigration's constructor so we
 * can capture the options bag and assert the five field-level wirings:
 *
 *   adapter         === app.vault.adapter
 *   legacyDbPath    === plan.pluginCacheDbPath
 *   pluginDataRoot  === plan.roots.dataRoot
 *   blobStore       === this.cacheBlobStore (the IDB-backed instance)
 *   isMobile        === !isDesktop()
 *
 * Approach: lightweight Object.create harness identical in shape to the one
 * used in `cache-backend-rebuild-cache.test.ts` — bypass the heavy
 * HybridStorageAdapter constructor and inject only the fields the method-under-
 * test reads. The test is intentionally tightly coupled to the wiring shape so
 * a structural drift (e.g. accidental `plan.roots` replacement, or feeding the
 * vault.fileManager instead of vault.adapter) surfaces here.
 */

jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

// Spy on CacheBackendMigration so we can capture constructor opts.
const mockRunIfNeeded = jest.fn(async () => ({ outcome: 'verified' as const }));
const constructorSpy = jest.fn();
jest.mock('../../src/database/migration/CacheBackendMigration', () => {
  // Preserve the real CONFLICT_COPY_PATTERNS export shape so other modules
  // that consume the type from this module still type-check.
  const actual = jest.requireActual('../../src/database/migration/CacheBackendMigration');
  return {
    ...actual,
    CacheBackendMigration: jest.fn().mockImplementation((opts: unknown) => {
      constructorSpy(opts);
      return { runIfNeeded: mockRunIfNeeded };
    })
  };
});

import { HybridStorageAdapter } from '../../src/database/adapters/HybridStorageAdapter';
import { StoragePlanApplier } from '../../src/database/adapters/lifecycle/StoragePlanApplier';
import { isDesktop } from '../../src/utils/platform';

interface FakeStorageCoordinator {
  readCacheBackendState: jest.Mock<Promise<undefined>, []>;
  writeCacheBackendState: jest.Mock<Promise<void>, [unknown]>;
}

interface WiringHarness {
  adapter: HybridStorageAdapter;
  fakeAdapterValue: object;
  fakeBlobStore: object;
  storageCoordinator: FakeStorageCoordinator;
}

function buildWiringHarness(): WiringHarness {
  // Sentinels — we only assert reference equality.
  const fakeAdapterValue = { __sentinel: 'vault.adapter' };
  const fakeBlobStore = { __sentinel: 'cacheBlobStore' };

  const storageCoordinator: FakeStorageCoordinator = {
    readCacheBackendState: jest.fn(async () => undefined),
    writeCacheBackendState: jest.fn(async () => undefined)
  };

  const adapter = Object.create(HybridStorageAdapter.prototype) as HybridStorageAdapter;
  // The adapter delegates `runCacheBackendMigration` to StoragePlanApplier;
  // recreate that wiring here against the same injected fields. Production
  // ctor does the same in HybridStorageAdapter.constructor.
  const planApplier = new StoragePlanApplier({
    app: { vault: { adapter: fakeAdapterValue } } as never,
    jsonlWriter: {} as never,
    sqliteCache: {} as never,
    syncCoordinator: {} as never,
    storageCoordinator: storageCoordinator as never,
    cacheBlobStore: fakeBlobStore as never,
    onVaultEventStoreChanged: () => undefined,
    onBasePathChanged: () => undefined
  });
  Object.assign(adapter, {
    app: { vault: { adapter: fakeAdapterValue } },
    storageCoordinator,
    cacheBlobStore: fakeBlobStore,
    planApplier
  });

  return { adapter, fakeAdapterValue, fakeBlobStore, storageCoordinator };
}

describe('HybridStorageAdapter.runCacheBackendMigration wiring', () => {
  beforeEach(() => {
    constructorSpy.mockClear();
    mockRunIfNeeded.mockClear();
  });

  it('passes app.vault.adapter, plan.pluginCacheDbPath, plan.roots.dataRoot, this.cacheBlobStore, and isMobile=!isDesktop()', async () => {
    const h = buildWiringHarness();
    const plan = {
      pluginCacheDbPath: '.obsidian/plugins/nexus/data/cache.db',
      roots: { dataRoot: '.obsidian/plugins/nexus/data' }
    } as unknown as Parameters<HybridStorageAdapter['runCacheBackendMigration' & keyof HybridStorageAdapter]>[0];

    // Private method — call via type cast.
    await (h.adapter as unknown as {
      runCacheBackendMigration: (plan: unknown) => Promise<void>;
    }).runCacheBackendMigration(plan);

    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(mockRunIfNeeded).toHaveBeenCalledTimes(1);

    const opts = constructorSpy.mock.calls[0][0] as {
      adapter: unknown;
      legacyDbPath: string;
      pluginDataRoot: string;
      blobStore: unknown;
      isMobile: boolean;
      stateAccessor: { read: () => Promise<unknown>; write: (s: unknown) => Promise<void> };
    };

    // Reference equality — the wiring MUST forward the actual instances.
    expect(opts.adapter).toBe(h.fakeAdapterValue);
    expect(opts.legacyDbPath).toBe('.obsidian/plugins/nexus/data/cache.db');
    expect(opts.pluginDataRoot).toBe('.obsidian/plugins/nexus/data');
    expect(opts.blobStore).toBe(h.fakeBlobStore);
    expect(opts.isMobile).toBe(!isDesktop());

    // The stateAccessor must delegate to storageCoordinator. Verify by
    // calling read/write through the wiring and watching the coordinator.
    await opts.stateAccessor.read();
    expect(h.storageCoordinator.readCacheBackendState).toHaveBeenCalledTimes(1);

    const newState = { backend: 'idb', migrationState: 'verified' };
    await opts.stateAccessor.write(newState);
    expect(h.storageCoordinator.writeCacheBackendState).toHaveBeenCalledTimes(1);
    expect(h.storageCoordinator.writeCacheBackendState).toHaveBeenCalledWith(newState);
  });
});
