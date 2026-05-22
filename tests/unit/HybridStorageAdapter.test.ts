jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import {
  HybridStorageAdapter,
  shouldBlockStartupHydrationForVerifiedCutover
} from '../../src/database/adapters/HybridStorageAdapter';
import { StartupHydrationController } from '../../src/database/adapters/lifecycle/StartupHydrationController';
import { InitLifecycleController } from '../../src/database/adapters/lifecycle/InitLifecycleController';
import { ReconciliationCoordinator } from '../../src/database/adapters/lifecycle/ReconciliationCoordinator';
import { ConversationEventApplier } from '../../src/database/sync/ConversationEventApplier';

describe('HybridStorageAdapter', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

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

  describe('applyStoragePlan', () => {
    it('wires the vault event store and read gating into JSONLWriter', () => {
      const adapter = Object.create(HybridStorageAdapter.prototype) as HybridStorageAdapter & {
        app: unknown;
        basePath: string;
        mobileLogPath?: string;
        vaultEventStore: unknown;
        jsonlWriter: {
          setBasePath: jest.Mock<void, [string]>;
          setReadBasePaths: jest.Mock<void, [string[]]>;
          setVaultEventStore: jest.Mock<void, [unknown]>;
          setVaultEventStoreReadEnabled: jest.Mock<void, [boolean]>;
        };
        sqliteCache: {
          setDbPath: jest.Mock<void, [string]>;
        };
      };

      adapter.app = { vault: { adapter: {} } };
      adapter.jsonlWriter = {
        setBasePath: jest.fn(),
        setReadBasePaths: jest.fn(),
        setVaultEventStore: jest.fn(),
        setVaultEventStoreReadEnabled: jest.fn()
      };
      adapter.sqliteCache = {
        setDbPath: jest.fn()
      };

      (adapter as any).applyStoragePlan({
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
      });

      expect(adapter.jsonlWriter.setBasePath).toHaveBeenCalledWith('Nexus/data');
      expect(adapter.jsonlWriter.setReadBasePaths).toHaveBeenCalledWith([
        '.obsidian/plugins/claudesidian-mcp/data',
        '.nexus'
      ]);
      expect(adapter.jsonlWriter.setVaultEventStore).toHaveBeenCalledWith(expect.any(Object));
      expect(adapter.jsonlWriter.setVaultEventStoreReadEnabled).toHaveBeenCalledWith(true);
      expect(adapter.sqliteCache.setDbPath).toHaveBeenCalledWith('.obsidian/plugins/claudesidian-mcp/data/cache.db');
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

    it('does not resolve true before initialization completes just because hydration is idle', async () => {
      jest.useFakeTimers();
      const a = Object.create(HybridStorageAdapter.prototype) as AdapterPrivates;
      a.hydration = new StartupHydrationController();
      a.initLifecycle = new InitLifecycleController();
      void a.initLifecycle.run(
        () => new Promise<void>((resolve) => window.setTimeout(resolve, 100)),
        { blocking: false }
      );

      const pending = a.waitForQueryReady(500);
      let settled = false;
      void pending.then(() => { settled = true; });

      await jest.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(true);
    });
  });

  describe('startup full rebuild recovery', () => {
    type StartupRebuildHarness = {
      hydration: StartupHydrationController;
      initLifecycle: InitLifecycleController;
      syncCoordinator: {
        fullRebuild: jest.Mock;
      };
      startupRebuildIdleTimeoutMs: number;
    };

    const successfulRebuild = {
      success: true,
      eventsApplied: 0,
      eventsSkipped: 0,
      errors: [],
      duration: 0,
      filesProcessed: [],
      lastSyncTimestamp: 123
    };

    function makeHarness(): StartupRebuildHarness {
      const adapter = Object.create(HybridStorageAdapter.prototype) as unknown as StartupRebuildHarness;
      adapter.hydration = new StartupHydrationController();
      adapter.initLifecycle = new InitLifecycleController();
      adapter.startupRebuildIdleTimeoutMs = 50;
      adapter.syncCoordinator = {
        fullRebuild: jest.fn()
      };
      return adapter;
    }

    function runStartupFullRebuild(adapter: StartupRebuildHarness, isBlocking: boolean): Promise<void> {
      return (adapter as unknown as {
        runStartupFullRebuild(isBlockingHydration: boolean): Promise<void>;
      }).runStartupFullRebuild(isBlocking);
    }

    it('fails hydration when fullRebuild returns success:false', async () => {
      const adapter = makeHarness();
      adapter.hydration.startBlocking();
      adapter.syncCoordinator.fullRebuild.mockResolvedValue({
        ...successfulRebuild,
        success: false,
        errors: ['bad workspace event']
      });

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(runStartupFullRebuild(adapter, true)).rejects.toThrow('bad workspace event');
      } finally {
        errSpy.mockRestore();
      }

      const state = adapter.hydration.getState();
      expect(state.phase).toBe('error');
      expect(state.error).toContain('bad workspace event');
    });

    it('fails hydration when fullRebuild reports failure after making progress', async () => {
      const adapter = makeHarness();
      adapter.hydration.startBlocking();
      adapter.syncCoordinator.fullRebuild.mockImplementation(({ onProgress }) => {
        onProgress('Processing workspaces', 0, 1);
        onProgress('Processing workspace events', 25, 100);
        return Promise.resolve({
          ...successfulRebuild,
          success: false,
          eventsApplied: 25,
          errors: ['late trace replay failure']
        });
      });

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(runStartupFullRebuild(adapter, true)).rejects.toThrow('late trace replay failure');
      } finally {
        errSpy.mockRestore();
      }

      const state = adapter.hydration.getState();
      expect(state.phase).toBe('error');
      expect(state.error).toContain('late trace replay failure');
      expect((adapter as unknown as HybridStorageAdapter).isQueryReady()).toBe(false);
    });

    it('keeps adapter readiness failed when required startup fullRebuild returns success:false', async () => {
      const adapter = makeHarness();
      adapter.hydration.startBlocking();
      adapter.syncCoordinator.fullRebuild.mockResolvedValue({
        ...successfulRebuild,
        success: false,
        errors: ['bad workspace event']
      });

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        void adapter.initLifecycle.run(() => runStartupFullRebuild(adapter, true), { blocking: false });

        await expect((adapter as unknown as HybridStorageAdapter).waitForReady()).resolves.toBe(false);
        expect((adapter as unknown as HybridStorageAdapter).isReady()).toBe(false);
        expect((adapter as unknown as HybridStorageAdapter).isQueryReady()).toBe(false);
        expect((adapter as unknown as HybridStorageAdapter).getInitError()?.message).toContain('bad workspace event');
        await expect((adapter as unknown as HybridStorageAdapter).waitForQueryReady(50)).resolves.toBe(false);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('fails hydration when startup fullRebuild stalls without progress', async () => {
      jest.useFakeTimers();
      const adapter = makeHarness();
      adapter.hydration.startBlocking();
      adapter.syncCoordinator.fullRebuild.mockReturnValue(new Promise(() => undefined));

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const pending = runStartupFullRebuild(adapter, true);
        const rejection = expect(pending).rejects.toThrow('made no progress');
        await jest.advanceTimersByTimeAsync(50);

        await rejection;
        const state = adapter.hydration.getState();
        expect(state.phase).toBe('error');
        expect(state.error).toContain('made no progress');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('settles adapter initialization as failed when startup fullRebuild stalls', async () => {
      jest.useFakeTimers();
      const adapter = makeHarness();
      adapter.hydration.startBlocking();
      adapter.syncCoordinator.fullRebuild.mockReturnValue(new Promise(() => undefined));
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        void adapter.initLifecycle.run(() => runStartupFullRebuild(adapter, true), { blocking: false });
        const waitForReady = (adapter as unknown as HybridStorageAdapter).waitForReady();
        const waitForQueryReady = (adapter as unknown as HybridStorageAdapter).waitForQueryReady(500);

        await jest.advanceTimersByTimeAsync(50);

        await expect(waitForReady).resolves.toBe(false);
        await expect(waitForQueryReady).resolves.toBe(false);
        expect((adapter as unknown as HybridStorageAdapter).isReady()).toBe(false);
        expect((adapter as unknown as HybridStorageAdapter).isQueryReady()).toBe(false);
        expect((adapter as unknown as HybridStorageAdapter).getInitError()?.message).toContain('made no progress');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('does not fail a slow startup fullRebuild while progress continues', async () => {
      jest.useFakeTimers();
      const adapter = makeHarness();
      adapter.hydration.startBlocking();
      adapter.syncCoordinator.fullRebuild.mockImplementation(({ onProgress }) => new Promise((resolve) => {
        onProgress('Processing workspaces', 0, 3);
        window.setTimeout(() => onProgress('Processing workspaces', 1, 3), 40);
        window.setTimeout(() => onProgress('Processing conversations', 2, 3), 80);
        window.setTimeout(() => resolve(successfulRebuild), 120);
      }));

      const pending = runStartupFullRebuild(adapter, true);
      await jest.advanceTimersByTimeAsync(119);
      expect(adapter.hydration.getState().phase).toBe('running');

      await jest.advanceTimersByTimeAsync(1);
      await pending;

      const state = adapter.hydration.getState();
      expect(state.phase).toBe('running');
      expect(state.error).toBeUndefined();
    });
  });

  describe('reconcileMissingConversations', () => {
    it('replays missing conversation JSONL files into SQLite cache', async () => {
      const adapter = Object.create(HybridStorageAdapter.prototype) as HybridStorageAdapter & {
        jsonlWriter: {
          listFiles: jest.Mock<Promise<string[]>, [string]>;
          readEvents: jest.Mock<Promise<Array<{ type: string; timestamp: number }>>, [string]>;
        };
        conversationRepo: {
          getById: jest.Mock<Promise<null>, [string]>;
        };
        sqliteCache: {
          save: jest.Mock<Promise<void>, []>;
        };
        reconciliationCoordinator: ReconciliationCoordinator;
        reconcileMissingConversations: () => Promise<number>;
      };

      adapter.jsonlWriter = {
        listFiles: jest.fn().mockResolvedValue(['conversations/conv_desktop-sync.jsonl']),
        readEvents: jest.fn().mockResolvedValue([
          { type: 'message', timestamp: 20 },
          { type: 'metadata', timestamp: 10 },
          { type: 'message_updated', timestamp: 30 }
        ])
      };
      adapter.conversationRepo = {
        getById: jest.fn().mockResolvedValue(null)
      };
      adapter.sqliteCache = {
        save: jest.fn().mockResolvedValue(undefined)
      };
      adapter.reconciliationCoordinator = new ReconciliationCoordinator(
        adapter.jsonlWriter as never,
        adapter.sqliteCache as never
      );

      const applySpy = jest
        .spyOn(ConversationEventApplier.prototype, 'apply')
        .mockResolvedValue(undefined);

      try {
        await adapter.reconcileMissingConversations();

        expect(adapter.jsonlWriter.listFiles).toHaveBeenCalledWith('conversations');
        expect(adapter.conversationRepo.getById).toHaveBeenCalledWith('desktop-sync');
        expect(applySpy).toHaveBeenCalledTimes(3);
        expect(applySpy.mock.calls[0][0]).toMatchObject({ type: 'metadata', timestamp: 10 });
        expect(applySpy.mock.calls[1][0]).toMatchObject({ type: 'message', timestamp: 20 });
        expect(applySpy.mock.calls[2][0]).toMatchObject({ type: 'message_updated', timestamp: 30 });
        expect(adapter.sqliteCache.save).toHaveBeenCalledTimes(1);
      } finally {
        applySpy.mockRestore();
      }
    });
  });
});
