jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import {
  HybridStorageAdapter,
  shouldBlockStartupHydrationForVerifiedCutover
} from '../../src/database/adapters/HybridStorageAdapter';
import { StartupHydrationController } from '../../src/database/adapters/lifecycle/StartupHydrationController';
import { InitLifecycleController } from '../../src/database/adapters/lifecycle/InitLifecycleController';
import { ReconciliationCoordinator } from '../../src/database/adapters/lifecycle/ReconciliationCoordinator';
import { StoragePlanApplier } from '../../src/database/adapters/lifecycle/StoragePlanApplier';
import { MissingEntityReconcilerRunner } from '../../src/database/adapters/lifecycle/MissingEntityReconcilers';
import { ConversationEventApplier } from '../../src/database/sync/ConversationEventApplier';

describe('HybridStorageAdapter', () => {
  describe('shouldBlockStartupHydrationForVerifiedCutover', () => {
    it('returns true for verified cutover when cache is empty but vault conversations exist', () => {
      expect(shouldBlockStartupHydrationForVerifiedCutover({
        migrationState: 'verified',
        sourceOfTruthLocation: 'vault-root',
        conversationFileCount: 12,
        cachedConversationCount: 0,
        cachedMessageCount: 0
      })).toBe(true);
    });

    it('returns false when the cache already has conversations', () => {
      expect(shouldBlockStartupHydrationForVerifiedCutover({
        migrationState: 'verified',
        sourceOfTruthLocation: 'vault-root',
        conversationFileCount: 12,
        cachedConversationCount: 4,
        cachedMessageCount: 20
      })).toBe(false);
    });

    it('returns false before verified cutover', () => {
      expect(shouldBlockStartupHydrationForVerifiedCutover({
        migrationState: 'pending',
        sourceOfTruthLocation: 'legacy-dotnexus',
        conversationFileCount: 12,
        cachedConversationCount: 0,
        cachedMessageCount: 0
      })).toBe(false);
    });
  });

  describe('StoragePlanApplier.applyStoragePlan', () => {
    it('wires the vault event store and read gating into JSONLWriter', () => {
      const jsonlWriter = {
        setBasePath: jest.fn(),
        setReadBasePaths: jest.fn(),
        setVaultEventStore: jest.fn(),
        setVaultEventStoreReadEnabled: jest.fn(),
        getDeviceId: jest.fn(() => 'test-device')
      };
      const sqliteCache = {
        setDbPath: jest.fn(),
        getSyncStateStore: jest.fn(() => ({}))
      };
      const syncCoordinator = {
        getAppliers: jest.fn(() => ({ workspace: {}, conversation: {}, task: {} })),
        setReconcilePipeline: jest.fn()
      };

      const planApplier = new StoragePlanApplier({
        app: { vault: { adapter: {} } } as never,
        jsonlWriter: jsonlWriter as never,
        sqliteCache: sqliteCache as never,
        syncCoordinator: syncCoordinator as never,
        storageCoordinator: {} as never,
        cacheBlobStore: {} as never,
        onVaultEventStoreChanged: () => undefined,
        onBasePathChanged: () => undefined
      });

      planApplier.applyStoragePlan({
        vaultWriteBasePath: 'Nexus/data',
        legacyReadBasePaths: ['.obsidian/plugins/claudesidian-mcp/data', '.nexus'],
        pluginCacheDbPath: '.obsidian/plugins/claudesidian-mcp/data/cache.db',
        mobileLogPath: 'Nexus/data/_meta/mobile-sync-log.md',
        state: {
          storageVersion: 2,
          sourceOfTruthLocation: 'vault-root',
          migration: {
            state: 'verified',
            legacySourcesDetected: ['.obsidian/plugins/claudesidian-mcp/data', '.nexus'],
            activeDestination: 'Nexus/data'
          }
        },
        roots: {} as never,
        vaultRoot: {
          configuredPath: 'Nexus',
          resolvedPath: 'Nexus',
          dataPath: 'Nexus/data',
          guidesPath: 'Nexus/guides',
          maxShardBytes: 1024
        }
      } as never);

      expect(jsonlWriter.setBasePath).toHaveBeenCalledWith('Nexus/data');
      expect(jsonlWriter.setReadBasePaths).toHaveBeenCalledWith([
        '.obsidian/plugins/claudesidian-mcp/data',
        '.nexus'
      ]);
      expect(jsonlWriter.setVaultEventStore).toHaveBeenCalledWith(expect.any(Object));
      expect(jsonlWriter.setVaultEventStoreReadEnabled).toHaveBeenCalledWith(true);
      expect(sqliteCache.setDbPath).toHaveBeenCalledWith('.obsidian/plugins/claudesidian-mcp/data/cache.db');
    });
  });

  describe('waitForQueryReady (event-based, via controllers)', () => {
    type AdapterPrivates = HybridStorageAdapter & {
      hydration: StartupHydrationController;
      initLifecycle: InitLifecycleController;
    };

    function makeAdapter(phase: 'idle' | 'running' | 'complete' | 'error' = 'running'): AdapterPrivates {
      const a = Object.create(HybridStorageAdapter.prototype) as AdapterPrivates;
      const hydration = new StartupHydrationController();
      // Drive the controller to the requested phase via its public API.
      if (phase === 'running') {
        hydration.startBlocking();
      } else if (phase === 'complete') {
        hydration.complete();
      } else if (phase === 'error') {
        hydration.fail('seeded-error');
      }
      // phase === 'idle' is the default constructor state.
      const initLifecycle = new InitLifecycleController();
      // Mark the lifecycle as ready (init has succeeded) so isReady() is true
      // independently of the hydration phase. We do this by running a no-op
      // and awaiting it synchronously via a settled promise.
      void initLifecycle.run(async () => undefined, { blocking: false });
      (a as unknown as { hydration: StartupHydrationController }).hydration = hydration;
      (a as unknown as { initLifecycle: InitLifecycleController }).initLifecycle = initLifecycle;
      return a;
    }

    it('returns true immediately when already query-ready', async () => {
      const a = makeAdapter('idle');
      await a.initLifecycle.waitForReady();
      await expect(a.waitForQueryReady(50)).resolves.toBe(true);
    });

    it('resolves true when hydration completes', async () => {
      const a = makeAdapter('running');
      await a.initLifecycle.waitForReady();
      const pending = a.waitForQueryReady(5_000);
      a.hydration.complete();
      await expect(pending).resolves.toBe(true);
    });

    it('resolves true when hydration is cleared', async () => {
      const a = makeAdapter('running');
      await a.initLifecycle.waitForReady();
      const pending = a.waitForQueryReady(5_000);
      a.hydration.clear();
      await expect(pending).resolves.toBe(true);
    });

    it('resolves false when hydration fails', async () => {
      const a = makeAdapter('running');
      await a.initLifecycle.waitForReady();
      const pending = a.waitForQueryReady(5_000);
      a.hydration.fail('boom');
      await expect(pending).resolves.toBe(false);
    });

    it('resolves false on timeout when no transition fires', async () => {
      const a = makeAdapter('running');
      await a.initLifecycle.waitForReady();
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(a.waitForQueryReady(20)).resolves.toBe(false);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('settles all concurrent waiters at the same transition', async () => {
      const a = makeAdapter('running');
      await a.initLifecycle.waitForReady();
      const p1 = a.waitForQueryReady(5_000);
      const p2 = a.waitForQueryReady(5_000);
      const p3 = a.waitForQueryReady(5_000);
      a.hydration.complete();
      await expect(Promise.all([p1, p2, p3])).resolves.toEqual([true, true, true]);
    });
  });

  describe('MissingEntityReconcilerRunner.conversations', () => {
    it('replays missing conversation JSONL files into SQLite cache', async () => {
      const jsonlWriter = {
        listFiles: jest.fn().mockResolvedValue(['conversations/conv_desktop-sync.jsonl']),
        readEvents: jest.fn().mockResolvedValue([
          { type: 'message', timestamp: 20 },
          { type: 'metadata', timestamp: 10 },
          { type: 'message_updated', timestamp: 30 }
        ])
      };
      const conversationRepo = { getById: jest.fn().mockResolvedValue(null) };
      const sqliteCache = { save: jest.fn().mockResolvedValue(undefined) };
      const coordinator = new ReconciliationCoordinator(
        jsonlWriter as never,
        sqliteCache as never
      );
      const runner = new MissingEntityReconcilerRunner(
        () => coordinator,
        {
          sqliteCache: sqliteCache as never,
          workspaceRepo: {} as never,
          conversationRepo: conversationRepo as never
        }
      );

      const applySpy = jest
        .spyOn(ConversationEventApplier.prototype, 'apply')
        .mockResolvedValue(undefined);

      try {
        await runner.conversations();

        expect(jsonlWriter.listFiles).toHaveBeenCalledWith('conversations');
        expect(conversationRepo.getById).toHaveBeenCalledWith('desktop-sync');
        expect(applySpy).toHaveBeenCalledTimes(3);
        expect(applySpy.mock.calls[0][0]).toMatchObject({ type: 'metadata', timestamp: 10 });
        expect(applySpy.mock.calls[1][0]).toMatchObject({ type: 'message', timestamp: 20 });
        expect(applySpy.mock.calls[2][0]).toMatchObject({ type: 'message_updated', timestamp: 30 });
        expect(sqliteCache.save).toHaveBeenCalledTimes(1);
      } finally {
        applySpy.mockRestore();
      }
    });
  });
});
